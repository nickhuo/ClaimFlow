import { authorizedSubject, initialConversation, RuleViolation } from "../domain/conversation.ts";
import type {
  ConversationHarness,
  HarnessFactory,
  PublicEvent,
  SessionAccess,
  TurnInput,
  TurnResult,
} from "./session-ports.ts";
import { BusinessContext, type BusinessDependencies } from "./conversation/context.ts";
import { BusinessOperations } from "./conversation/tools.ts";
import { renderReply, sessionView } from "./conversation/reply.ts";
import { acceptsCustomerReply, customerReplyInput } from "./conversation/customer-reply.ts";
import { maskEmail } from "./follow-up.ts";

interface ActiveRun {
  readonly input: TurnInput;
  readonly controller: AbortController;
}

/** The public conversation interface owns ordering, cancellation, expiry and idempotency. */
export class ConversationService {
  readonly #queues = new Map<string, Promise<void>>();
  readonly #harnesses = new Map<string, ConversationHarness>();
  readonly #active = new Map<string, ActiveRun>();
  readonly #accesses = new Map<string, SessionAccess>();
  #closed = false;
  constructor(
    readonly dependencies: BusinessDependencies,
    readonly harnessFactory: HarnessFactory,
    readonly runTimeoutMs = 60_000,
  ) {}

  async create() {
    if (this.#closed) throw new RuleViolation("service_unavailable");
    const { access, record } = await this.dependencies.store.create(
      initialConversation(),
      this.dependencies.clock.now(),
      this.dependencies.policy.sessionIdleTimeoutMs,
    );
    return {
      ...access,
      view: sessionView(record, this.dependencies.clock.now(), this.dependencies.policy),
    };
  }
  async #read(access: SessionAccess) {
    let record;
    try {
      record = await this.dependencies.store.read(access, this.dependencies.clock.now());
    } catch (error) {
      if (error instanceof RuleViolation && error.code === "session_expired") {
        this.#active.get(access.sessionId)?.controller.abort();
        void this.#release(access.sessionId);
      }
      throw error;
    }
    if (
      record.state.identity.status === "verified" &&
      this.dependencies.clock.now() >=
        record.state.identity.verifiedAt + this.dependencies.policy.sessionIdleTimeoutMs
    ) {
      await this.dependencies.store.revoke(access, this.dependencies.clock.now());
      this.#active.get(access.sessionId)?.controller.abort();
      void this.#release(access.sessionId);
      throw new RuleViolation("session_expired");
    }
    return record;
  }
  async view(access: SessionAccess) {
    return sessionView(
      await this.#read(access),
      this.dependencies.clock.now(),
      this.dependencies.policy,
    );
  }
  async outbox(access: SessionAccess) {
    const subjectId = authorizedSubject(
      (await this.#read(access)).state,
      this.dependencies.clock.now(),
      this.dependencies.policy,
    );
    return (await this.dependencies.store.deliveries(access, this.dependencies.clock.now()))
      .filter((item) => item.subjectId === subjectId)
      .map((item) => ({
        id: item.id,
        summaryVersion: item.summaryVersion,
        recipient: maskEmail(item.recipient),
        body: item.body,
        status: item.status,
        createdAt: item.createdAt,
      }));
  }
  async turn(
    access: SessionAccess,
    input: TurnInput,
    emit: (event: PublicEvent) => void = () => {},
  ): Promise<TurnResult> {
    await this.#read(access);
    if (this.#closed) throw new RuleViolation("service_unavailable");
    const previous = this.#queues.get(access.sessionId) ?? Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(() => {
        const run = () => this.#run(access, input, emit);
        return this.dependencies.store.withSessionLock?.(access, run) ?? run();
      });
    const tail = work.then(
      () => {},
      () => {},
    );
    this.#queues.set(access.sessionId, tail);
    try {
      return await work;
    } finally {
      if (this.#queues.get(access.sessionId) === tail) this.#queues.delete(access.sessionId);
    }
  }
  async #run(
    access: SessionAccess,
    input: TurnInput,
    emit: (event: PublicEvent) => void,
  ): Promise<TurnResult> {
    await this.#read(access);
    const replay = await this.dependencies.store.beginRequest(
      access,
      input,
      this.dependencies.clock.now(),
    );
    if (replay) {
      if ((await this.#read(access)).version !== replay.view.version)
        throw new RuleViolation("stale_request");
      emit({ type: "result", requestId: input.requestId, result: replay });
      return replay;
    }
    const active = { input, controller: new AbortController() };
    this.#active.set(access.sessionId, active);
    const context = new BusinessContext(
      this.dependencies,
      access,
      input,
      active.controller.signal,
      async () => {
        if (this.#active.get(access.sessionId) !== active || this.#closed)
          throw new RuleViolation("cancelled");
        if (await this.dependencies.store.isRequestCancelled?.(access, input.requestId)) {
          active.controller.abort();
          throw new RuleViolation("cancelled");
        }
      },
    );
    const operations = new BusinessOperations(context);
    const publish = async (event: PublicEvent) => {
      await context.read();
      emit(event);
    };
    let error: TurnResult["error"] = null;
    let customerReply: string | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      active.controller.abort();
    }, this.runTimeoutMs);
    let polling = false;
    const cancellationPoll = this.dependencies.store.isRequestCancelled
      ? setInterval(() => {
          if (polling) return;
          polling = true;
          void (async () => {
            try {
              await this.#read(access);
              if (await this.dependencies.store.isRequestCancelled?.(access, input.requestId))
                active.controller.abort();
            } catch {
              active.controller.abort();
            } finally {
              polling = false;
            }
          })();
        }, 1000)
      : null;
    cancellationPoll?.unref();
    try {
      await publish({ type: "waiting", requestId: input.requestId });
      if (input.action?.type === "handoff")
        await operations.execute("handoff", { reason: "caller_request" });
      else if (input.action?.type === "finish")
        await operations.execute("complete_case", { confirmationTurnId: input.requestId });
      else if (input.action?.type === "resume")
        await operations.execute("resume_case", { turnId: input.requestId });
      else if (input.action?.type === "check_delivery")
        await operations.execute("send_summary", { summaryVersion: input.action.summaryVersion });
      else if (input.action?.type === "send" || input.action?.type === "skip") {
        await operations.execute("set_email_consent", {
          decision: input.action.type,
          summaryVersion: input.action.summaryVersion,
          confirmationTurnId: input.requestId,
        });
        if (input.action.type === "send")
          await operations.execute("send_summary", { summaryVersion: input.action.summaryVersion });
      } else {
        let harness = this.#harnesses.get(access.sessionId);
        if (!harness) {
          harness = await this.harnessFactory.create();
          try {
            await context.read();
          } catch (cause) {
            await harness.close();
            throw cause;
          }
          this.#harnesses.set(access.sessionId, harness);
          this.#accesses.set(access.sessionId, access);
        }
        await harness.run({
          input,
          signal: active.controller.signal,
          context: () => context.projection(),
          authorize: (name, args) => operations.authorize(name, args),
          execute: (name, args) => operations.execute(name, args),
          onProgress: async (activity) =>
            publish({
              type: "progress",
              requestId: input.requestId,
              phase: (await context.read()).state.phase,
              activity,
            }),
        });
      }
      const record = await context.read();
      if (this.dependencies.replyComposer) {
        const approvedResponse = renderReply(
          record.state,
          this.dependencies.clock.now(),
          this.dependencies.policy,
          context.clarification,
        );
        await publish({
          type: "progress",
          requestId: input.requestId,
          phase: record.state.phase,
          activity: "replying",
        });
        const reply = await this.dependencies.replyComposer.compose(
          customerReplyInput(input.text, approvedResponse, record.state),
          active.controller.signal,
        );
        const current = await context.read();
        // Late model text cannot survive cancellation, reset, or a changed permission projection.
        await this.#read(access);
        if (
          current.version !== record.version ||
          renderReply(
            current.state,
            this.dependencies.clock.now(),
            this.dependencies.policy,
            context.clarification,
          ) !== approvedResponse ||
          !acceptsCustomerReply(reply, approvedResponse, current.state)
        )
          throw new Error("customer_reply_rejected");
        customerReply = reply;
      }
    } catch (cause) {
      error =
        timedOut || (cause instanceof Error && cause.message === "run_limit")
          ? "run_limit"
          : active.controller.signal.aborted
            ? "cancelled"
            : "model_unavailable";
      await this.#release(access.sessionId);
    } finally {
      clearTimeout(timeout);
      if (cancellationPoll) clearInterval(cancellationPoll);
    }
    try {
      // Read directly after cancellation; business writes and late events remain blocked by the run signal.
      const record = await this.#read(access);
      let reply =
        customerReply ??
        renderReply(
          record.state,
          this.dependencies.clock.now(),
          this.dependencies.policy,
          context.clarification,
        );
      if (error)
        reply +=
          error === "cancelled"
            ? "\n\nThis response was cancelled. Confirmed progress has been saved."
            : "\n\nThe assistant couldn't finish this response. Confirmed progress has been saved; please try again.";
      const result: TurnResult = {
        requestId: input.requestId,
        view: sessionView(record, this.dependencies.clock.now(), this.dependencies.policy),
        reply,
        error,
      };
      await this.dependencies.store.finishRequest(access, result, this.dependencies.clock.now());
      emit({ type: "result", requestId: input.requestId, result });
      return result;
    } finally {
      if (this.#active.get(access.sessionId) === active) this.#active.delete(access.sessionId);
    }
  }
  async cancel(access: SessionAccess, requestId: string): Promise<void> {
    await this.#read(access);
    await this.dependencies.store.cancelRequest?.(access, requestId, this.dependencies.clock.now());
    const active = this.#active.get(access.sessionId);
    if (active?.input.requestId === requestId) {
      active.controller.abort();
      await this.#release(access.sessionId);
    }
  }
  async reset(access: SessionAccess) {
    await this.#read(access);
    await this.dependencies.store.revoke(access, this.dependencies.clock.now());
    this.#active.get(access.sessionId)?.controller.abort();
    await this.#release(access.sessionId);
    return this.create();
  }
  async #release(id: string) {
    const harness = this.#harnesses.get(id);
    this.#harnesses.delete(id);
    this.#accesses.delete(id);
    await harness?.close();
  }
  async reapExpired(): Promise<void> {
    for (const [id, access] of this.#accesses) {
      try {
        await this.#read(access);
      } catch {
        this.#active.get(id)?.controller.abort();
        await this.#release(id);
      }
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const run of this.#active.values()) run.controller.abort();
    await Promise.all([...this.#harnesses.keys()].map((id) => this.#release(id)));
    await Promise.allSettled([...this.#queues.values()]);
    await this.dependencies.store.close();
  }
}
