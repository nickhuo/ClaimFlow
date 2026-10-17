import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  Flex,
  IconButton,
  Skeleton,
  Text,
  TextArea,
  TextField,
  Theme,
  Tooltip,
} from "@radix-ui/themes";
import {
  ArrowUp,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  FileText,
  Inbox,
  LifeBuoy,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import type { PublicEvent, SessionView, TurnInput } from "../application/session-ports.ts";
import {
  ApiError,
  openSession,
  remember,
  request,
  sessionPath,
  streamTurn,
  type Configuration,
  type OutboxItem,
  type Session,
} from "./api.ts";
import "@radix-ui/themes/styles.css";
import "./app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});
const sample =
  "My name is Margaret Chen, date of birth 1985-03-15, and my SSN last four is 4472. My policy is POL-9921. Why was my January 2026 healthcare claim denied?";
const steps = [
  ["VERIFY_ID", "Verify your identity", "A few details to keep your claim safe."],
  ["RESOLVE_INTENT", "Find your claim", "Pick up the details you’ve already shared."],
  ["PROCESS_CASE", "Work through it", "Understand your claim and next steps."],
  ["POST_PROCESS", "Wrap up together", "Review a summary. Email is your choice."],
] as const;
const activities = {
  verifying: "Checking your identity",
  authorization: "Checking authorization",
  locating: "Finding your claim",
  reading: "Looking into your claim",
  preparing: "Preparing your summary",
  replying: "Writing your answer",
  sending: "Checking your email request",
  handoff: "Recording your request",
};
const deliveryLabels: Record<string, string> = {
  mock_recorded: "Recorded in demo outbox · no email sent",
  submitted: "Accepted by email service",
  pending: "Email request pending",
  unknown: "Delivery status not yet confirmed",
  failed: "Email request failed",
};
const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : "We couldn't reach the assistant. Please try again.";

function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark${small ? " small" : ""}`} aria-hidden="true" />;
}

function ReplyText({ text }: { text: string }) {
  return (
    <div className="reply-text">
      {text.split(/\n\n+/).map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}

function App() {
  const session = useQuery({ queryKey: ["session"], queryFn: openSession, staleTime: Infinity });
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => request<Configuration>("/api/config"),
    staleTime: Infinity,
  });
  if (!session.data || !config.data)
    return (
      <main className="startup">
        <BrandMark />
        <h1>Claims desk</h1>
        {session.error || config.error ? (
          <>
            <p role="alert">{errorText(session.error ?? config.error)}</p>
            <Button
              onClick={() => {
                void session.refetch();
                void config.refetch();
              }}
            >
              Try again
            </Button>
          </>
        ) : (
          <>
            <p>Opening your conversation…</p>
            <Skeleton height="80px" width="240px" />
          </>
        )}
      </main>
    );
  return <Conversation key={session.data.sessionId} initial={session.data} config={config.data} />;
}

function Conversation({ initial, config }: { initial: Session; config: Configuration }) {
  const client = useQueryClient();
  const [view, setView] = useState(initial.view);
  const [messages, setMessages] = useState<
    { id: string; role: "user" | "assistant"; text: string }[]
  >([]);
  const [draft, setDraft] = useState("");
  const [activity, setActivity] = useState("Ready when you are");
  const [retry, setRetry] = useState<TurnInput | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const progressToggle = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previousSummary = useRef<number | undefined>(undefined);
  const active = useRef<{ input: TurnInput; controller: AbortController } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
    };
  }, []);
  useLayoutEffect(() => {
    const input = editor.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [draft]);
  useLayoutEffect(() => {
    const area = scroll.current;
    const newSummary = view.summary && view.summary.version !== previousSummary.current;
    previousSummary.current = view.summary?.version;
    if (!(messages.length || view.summary || view.handoff) || !follow.current || !area) return;
    const anchor = newSummary
      ? area.querySelector<HTMLElement>(".summary-card")
      : messages.at(-1)?.role === "assistant"
        ? area.querySelector<HTMLElement>(".message:last-child")
        : null;
    // Long replies and summaries start at their beginning, so the answer is not skipped.
    area.scrollTop =
      anchor && (newSummary || anchor.offsetHeight > area.clientHeight * 0.75)
        ? area.scrollTop +
          anchor.getBoundingClientRect().top -
          area.getBoundingClientRect().top -
          20
        : area.scrollHeight;
    follow.current = area.scrollHeight - area.scrollTop - area.clientHeight < 120;
    setShowLatest(!follow.current);
  }, [messages, view.summary, view.handoff, activity, progressOpen]);
  const turn = useMutation({
    mutationFn: async (input: TurnInput) => {
      const controller = new AbortController();
      active.current = { input, controller };
      return streamTurn(initial, input, controller.signal, (event: PublicEvent) => {
        if (!mounted.current) return;
        if (event.type === "waiting") setActivity("Working on your request");
        if (event.type === "progress") setActivity(activities[event.activity]);
      });
    },
    onSuccess(result) {
      if (!mounted.current) return;
      setView(result.view);
      setMessages((old) => [
        ...old,
        { id: `${result.requestId}-reply`, role: "assistant", text: result.reply },
      ]);
      setActivity(result.view.status === "active" ? "Ready when you are" : "Conversation complete");
      setRetry(null);
      setNotice(null);
      void client.invalidateQueries({ queryKey: ["outbox", initial.sessionId] });
    },
    onError(error, input) {
      if (!mounted.current) return;
      setNotice(errorText(error));
      setRetry(input);
      setActivity("Your message is saved here");
    },
    onSettled() {
      active.current = null;
    },
  });
  const reset = useMutation({
    mutationFn: () => request<Session>(sessionPath(initial, "/reset"), "POST", {}, initial),
    onSuccess(session) {
      active.current?.controller.abort();
      client.removeQueries({ queryKey: ["outbox", initial.sessionId] });
      client.setQueryData(["session"], remember(session));
    },
    onError(error) {
      if (
        error instanceof ApiError &&
        ["session_expired", "session_not_found"].includes(error.code)
      ) {
        sessionStorage.removeItem("claims-session");
        void client.invalidateQueries({ queryKey: ["session"] });
      } else setNotice(errorText(error));
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      request(
        sessionPath(initial, "/cancel"),
        "POST",
        { requestId: active.current?.input.requestId },
        initial,
      ),
    onError(error) {
      setNotice(errorText(error));
    },
  });
  const busy = turn.isPending || reset.isPending;
  const closed = view.status === "handoff_requested" || view.status === "completed";
  function submit(input: TurnInput, replay = false) {
    if (active.current || busy) return;
    follow.current = true;
    setShowLatest(false);
    setNotice(null);
    setRetry(null);
    if (!replay)
      setMessages((old) => [...old, { id: input.requestId, role: "user", text: input.text }]);
    setActivity("Sending your message");
    turn.mutate(input);
  }
  function action(text: string, value: NonNullable<TurnInput["action"]>) {
    if (value.type === "handoff") {
      setProgressOpen(false);
      if (progressToggle.current?.offsetParent) progressToggle.current.focus();
    }
    submit({ requestId: crypto.randomUUID(), text, action: value });
  }
  function sendDraft() {
    const text = draft.trim();
    if (!text || busy || closed) return;
    setDraft("");
    submit({ requestId: crypto.randomUUID(), text });
    editor.current?.focus();
  }
  function fillDraft(text: string) {
    setDraft(text);
    editor.current?.focus();
  }
  function jumpToLatest() {
    follow.current = true;
    setShowLatest(false);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }
  const current = steps.findIndex(([phase]) => phase === view.phase);
  const completed = view.status === "completed";
  const progressLabel = view.handoff
    ? "Human assistance requested"
    : completed
      ? "Your summary is ready"
      : steps[current]![1];
  return (
    <>
      <a className="skip-link" href="#message">
        Skip to message
      </a>
      <div className="app-shell">
        <header className="topbar">
          <a className="brand" href="/" aria-label="Claims desk home">
            <BrandMark />
            Claims desk
          </a>
          <Flex align="center" gap="4" className="topbar-actions">
            <span className="mode-label">
              <span />
              {config.mode === "demo" ? "Scripted demo" : "Live model"}
            </span>
            <AlertDialog.Root open={resetOpen} onOpenChange={setResetOpen}>
              <AlertDialog.Trigger>
                <Button variant="ghost" color="gray" size="2">
                  <RotateCcw size={14} /> New conversation
                </Button>
              </AlertDialog.Trigger>
              <AlertDialog.Content maxWidth="440px">
                <AlertDialog.Title>Start a new conversation?</AlertDialog.Title>
                <AlertDialog.Description>
                  Your current conversation will end. We’ll ask you to verify your identity again.
                </AlertDialog.Description>
                <Flex gap="3" justify="end" mt="5">
                  <AlertDialog.Cancel>
                    <Button variant="soft" color="gray">
                      Keep this conversation
                    </Button>
                  </AlertDialog.Cancel>
                  <Button onClick={() => reset.mutate()} loading={reset.isPending}>
                    Start new
                  </Button>
                </Flex>
              </AlertDialog.Content>
            </AlertDialog.Root>
          </Flex>
        </header>
        <main className="workspace">
          <section className="conversation" aria-label="Claim support conversation">
            <div className="conversation-heading">
              <div>
                <p className="eyebrow">A LITTLE CLARITY, EVERY STEP</p>
                <h1>A clear next step.</h1>
              </div>
              <span className="private-label">
                {view.verified ? <ShieldCheck size={14} /> : <LockKeyhole size={13} />}
                {view.verified ? "Identity verified" : "Private conversation"}
              </span>
            </div>
            <div className="transcript">
              <div
                className="scroll-area"
                ref={scroll}
                onScroll={() => {
                  const el = scroll.current!;
                  follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
                  setShowLatest(!follow.current);
                }}
              >
                {!messages.length && !view.summary && !closed && (
                  <div className="welcome">
                    <span className="welcome-kicker">
                      <span className="welcome-spark" aria-hidden="true">
                        ✳
                      </span>
                      A calmer way forward
                    </span>
                    <h2>
                      {initial.view.version > 0 ? (
                        <>
                          Pick up where
                          <br />
                          <em>you left off.</em>
                        </>
                      ) : (
                        <>
                          Let’s make sense
                          <br />
                          of your{" "}
                          <em>
                            claim<span>.</span>
                          </em>
                        </>
                      )}
                    </h2>
                    <p>
                      A question, a claim, a next step. We’ll work through it together, starting
                      with a few details to verify it’s you.
                    </p>
                    {initial.view.version === 0 && (
                      <Button
                        className="sample-button"
                        variant="surface"
                        size="3"
                        onClick={() => fillDraft(sample)}
                      >
                        <span className="sample-icon" aria-hidden="true">
                          <FileText size={20} strokeWidth={1.5} />
                        </span>
                        <span>
                          <strong>Try a sample conversation</strong>
                          <small>Margaret’s claim · sample details provided</small>
                        </span>
                        <ArrowRight size={18} />
                      </Button>
                    )}
                    <div className="starter-questions" aria-label="Conversation starters">
                      <span>Or start with your question</span>
                      <div>
                        <Button
                          variant="outline"
                          color="gray"
                          size="1"
                          onClick={() => fillDraft("Why was my claim denied?")}
                        >
                          Understand a denial <ArrowUpRight size={13} />
                        </Button>
                        <Button
                          variant="outline"
                          color="gray"
                          size="1"
                          onClick={() => fillDraft("I'd like to check the status of my claim.")}
                        >
                          Check claim status <ArrowUpRight size={13} />
                        </Button>
                      </div>
                    </div>
                    {initial.view.version > 0 && (
                      <p className="restored-note">
                        Your progress is restored. Messages from before this page was refreshed are
                        not stored here.
                      </p>
                    )}
                  </div>
                )}
                <div
                  className="messages"
                  role="log"
                  aria-label="Messages"
                  aria-live="polite"
                  aria-relevant="additions"
                >
                  {messages.map((item) => (
                    <article key={item.id} className={`message ${item.role}`}>
                      <div className="message-meta">
                        <BrandMark small />
                        Claims desk <span className="assistant-label">Assistant</span>
                      </div>
                      <div className="message-body">
                        <ReplyText text={item.text} />
                      </div>
                    </article>
                  ))}
                </div>
                {turn.isPending && (
                  <div className="pending-reply" aria-hidden="true">
                    <BrandMark small />
                    <span>
                      {activity}
                      <span className="working-dots">…</span>
                    </span>
                  </div>
                )}
                {view.summary && (
                  <Summary
                    key={view.summary.version}
                    view={view}
                    emailMode={config.email}
                    busy={busy}
                    onAction={action}
                  />
                )}
                {view.handoff && (
                  <Callout.Root className="handoff-notice">
                    <Callout.Icon>
                      <CircleHelp size={18} />
                    </Callout.Icon>
                    <Callout.Text>
                      Human assistance requested. This demo records the request; a live
                      representative has not been connected.
                    </Callout.Text>
                  </Callout.Root>
                )}
                {view.phase === "PROCESS_CASE" && !closed && (
                  <div className="next-actions">
                    <span className="eyebrow">KEEP GOING</span>
                    <Flex gap="2" wrap="wrap" className="follow-up-questions">
                      {["What documents do I need?", "What is the reimbursement amount?"].map(
                        (question) => (
                          <Button
                            key={question}
                            variant="outline"
                            color="gray"
                            size="1"
                            disabled={busy}
                            onClick={() => fillDraft(question)}
                          >
                            {question} <ArrowUpRight size={13} />
                          </Button>
                        ),
                      )}
                    </Flex>
                    <Button
                      variant="ghost"
                      size="2"
                      disabled={busy}
                      onClick={() => action("I'm finished with this claim", { type: "finish" })}
                    >
                      Finish & review summary <ArrowRight size={14} />
                    </Button>
                  </div>
                )}
              </div>
              {showLatest && (
                <Button className="jump-latest" variant="surface" size="1" onClick={jumpToLatest}>
                  <ArrowDown size={14} /> Latest messages
                </Button>
              )}
            </div>
            <div className="composer-area">
              {notice && (
                <Callout.Root color="amber" role="alert" mb="2">
                  <Callout.Text>
                    {notice}{" "}
                    {retry && (
                      <Button
                        variant="ghost"
                        size="1"
                        disabled={busy}
                        onClick={() => submit(retry, true)}
                      >
                        Try again
                      </Button>
                    )}
                  </Callout.Text>
                </Callout.Root>
              )}
              <div className="activity" role="status">
                {turn.isPending ? (
                  <LoaderCircle size={12} className="loading-icon" />
                ) : (
                  <span className="status-dot" data-closed={closed} />
                )}
                <span>
                  {closed
                    ? view.handoff
                      ? "Human assistance requested"
                      : "Conversation complete"
                    : activity}
                </span>
                {turn.isPending && (
                  <Button
                    variant="ghost"
                    size="1"
                    loading={cancel.isPending}
                    onClick={() => cancel.mutate()}
                  >
                    Cancel response
                  </Button>
                )}
              </div>
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  sendDraft();
                }}
              >
                <label className="sr-only" htmlFor="message">
                  Your message
                </label>
                <TextArea
                  id="message"
                  ref={editor}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      sendDraft();
                    }
                  }}
                  rows={2}
                  maxLength={6000}
                  placeholder={
                    closed
                      ? "Start a new conversation to continue"
                      : "Tell us what you need help with…"
                  }
                  autoComplete="off"
                  disabled={closed}
                  variant="soft"
                />
                <div className="composer-footer">
                  <span>
                    <span className="keyboard-hint">
                      <kbd>↵</kbd> to send <span>·</span> <kbd>⇧ ↵</kbd> for a new line
                    </span>
                    <span className="touch-hint">Your question, in your own words</span>
                  </span>
                  <Tooltip content="Send message">
                    <IconButton
                      aria-label="Send message"
                      type="submit"
                      size="3"
                      disabled={busy || closed || !draft.trim()}
                    >
                      <ArrowUp size={19} />
                    </IconButton>
                  </Tooltip>
                </div>
              </form>
              <p className="composer-note">
                <LockKeyhole size={11} aria-hidden="true" />
                Share only the last four digits of your SSN, never the full number.
              </p>
            </div>
          </section>
          <aside
            className="sidebar"
            aria-label="Conversation progress"
            data-expanded={progressOpen}
          >
            <button
              ref={progressToggle}
              className="mobile-progress-toggle"
              aria-expanded={progressOpen}
              aria-controls="progress-details"
              onClick={() => setProgressOpen(!progressOpen)}
            >
              <span className="mobile-step-number">
                {closed ? <Check size={14} /> : `0${current + 1}`}
              </span>
              <span>
                <small>{closed ? "CONVERSATION UPDATE" : `STEP ${current + 1} OF 4`}</small>
                <strong>{progressLabel}</strong>
              </span>
              <span className="mobile-progress-action">
                {progressOpen ? "Close" : "Details & help"}
                <ChevronDown size={14} />
              </span>
            </button>
            <div id="progress-details" className="sidebar-content">
              <div className="sidebar-heading">
                <span className="eyebrow">YOUR NEXT STEPS</span>
                <span className="step-count">
                  {completed ? "04" : `0${current + 1}`} <span>/ 04</span>
                </span>
              </div>
              <ol className="steps">
                {steps.map(([phase, title, detail], index) => (
                  <li
                    key={phase}
                    aria-current={index === current && !closed ? "step" : undefined}
                    className={index < current || completed ? "complete" : ""}
                  >
                    <span className="step-number">
                      {index < current || completed ? <Check size={14} /> : `0${index + 1}`}
                    </span>
                    <div>
                      <h3>{title}</h3>
                      <p>{detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
              {!view.verified && !closed && (
                <div className="identity-guide">
                  <span className="guide-icon">
                    <LockKeyhole size={15} />
                  </span>
                  <div>
                    <h3>A quick identity check</h3>
                    <p>
                      Have your full name, date of birth, and email or SSN last four handy. We’ll
                      check three details before opening your claim.
                    </p>
                  </div>
                </div>
              )}
              {view.verified && (
                <div className="verified-note">
                  <ShieldCheck size={16} />
                  <span>Identity verified. Your claim stays private.</span>
                </div>
              )}
              <Card className="support-card" variant="surface">
                <LifeBuoy size={21} strokeWidth={1.5} />
                <h3>A human touch, if you need it.</h3>
                <p>You can pause here or ask for human assistance at any point.</p>
                <Button
                  variant="ghost"
                  size="1"
                  disabled={busy || closed}
                  onClick={() => action("I want human assistance", { type: "handoff" })}
                >
                  Request human assistance <ArrowUpRight size={14} />
                </Button>
              </Card>
              <div className="environment-note">
                <span className="eyebrow">ABOUT THIS DEMO</span>
                <p>
                  Sample insurance records. Authorization and human handoff are simulated.{" "}
                  {config.email === "mock"
                    ? "Emails stay in the demo outbox."
                    : "Email requests use the configured service."}
                </p>
                <Outbox
                  session={initial}
                  enabled={view.verified && !view.handoff}
                  open={outboxOpen}
                  onOpenChange={setOutboxOpen}
                />
              </div>
            </div>
          </aside>
        </main>
        <footer className="page-footer">
          <span>Clarity at every step.</span>
          <span>Claims support demo</span>
        </footer>
      </div>
    </>
  );
}

function Summary({
  view,
  emailMode,
  busy,
  onAction,
}: {
  view: SessionView;
  emailMode: Configuration["email"];
  busy: boolean;
  onAction: (label: string, action: NonNullable<TurnInput["action"]>) => void;
}) {
  const [recipient, setRecipient] = useState("");
  const summary = view.summary!;
  const delivered =
    view.delivery?.status === "mock_recorded" || view.delivery?.status === "submitted";
  const uncertain = view.delivery?.status === "pending" || view.delivery?.status === "unknown";
  const done = view.status === "completed";
  return (
    <Card className="summary-card">
      <div className="summary-heading">
        <FileText size={24} strokeWidth={1.4} />
        <div>
          <span className="eyebrow">YOURS TO KEEP</span>
          <h3>A clear record of our conversation.</h3>
        </div>
      </div>
      <div className="summary-text">
        <ReplyText text={summary.text} />
      </div>
      {(view.delivery || done) && (
        <Text as="p" size="2" mt="3" weight="medium">
          {deliveryLabels[view.delivery?.status ?? ""] ??
            (done ? "Email skipped. Your summary stays here." : "Ready for your email choice.")}
        </Text>
      )}
      {!done && !delivered && !uncertain && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onAction("Email this summary", {
              type: "send",
              summaryVersion: summary.version,
              ...(recipient.trim() ? { recipient: recipient.trim() } : {}),
            });
          }}
        >
          <label className="recipient-label" htmlFor="recipient">
            Where would you like your summary?
            <span>Leave blank to use your verified email. Sending is always your choice.</span>
          </label>
          <TextField.Root
            id="recipient"
            type="email"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            maxLength={254}
          />
          <Flex gap="2" wrap="wrap" mt="4">
            <Button type="submit" disabled={busy}>
              {view.delivery?.status === "failed"
                ? "Retry email"
                : emailMode === "mock"
                  ? "Save to demo outbox"
                  : "Email summary"}
            </Button>
            <Button
              type="button"
              variant="soft"
              color="gray"
              disabled={busy}
              onClick={() =>
                onAction("Skip email", { type: "skip", summaryVersion: summary.version })
              }
            >
              Skip email
            </Button>
          </Flex>
        </form>
      )}
      {uncertain && (
        <Button
          mt="3"
          disabled={busy}
          variant="soft"
          onClick={() =>
            onAction("Check email status", {
              type: "check_delivery",
              summaryVersion: summary.version,
            })
          }
        >
          Check email status
        </Button>
      )}
      {!uncertain && (
        <Button
          mt="3"
          size="1"
          variant="ghost"
          disabled={busy}
          onClick={() => onAction("I have another question about this claim", { type: "resume" })}
        >
          Ask another question <ArrowUpRight size={14} />
        </Button>
      )}
    </Card>
  );
}

function Outbox({
  session,
  enabled,
  open,
  onOpenChange,
}: {
  session: Session;
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const items = useQuery({
    queryKey: ["outbox", session.sessionId],
    queryFn: () =>
      request<{ deliveries: OutboxItem[] }>(
        sessionPath(session, "/outbox"),
        "GET",
        undefined,
        session,
      ),
    enabled: open && enabled,
  });
  return (
    <Dialog.Root open={open && enabled} onOpenChange={onOpenChange}>
      <Dialog.Trigger>
        <Button variant="ghost" size="1" disabled={!enabled}>
          <Inbox size={15} /> View outbox <ArrowUpRight size={14} />
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="540px">
        <Flex justify="between" align="start">
          <div>
            <Dialog.Title>Your outbox</Dialog.Title>
            <Dialog.Description size="2">
              Email requests for this verified conversation.
            </Dialog.Description>
          </div>
          <Dialog.Close>
            <IconButton variant="ghost" color="gray" aria-label="Close outbox">
              <X size={19} />
            </IconButton>
          </Dialog.Close>
        </Flex>
        {items.isPending && <Skeleton height="80px" mt="4" />}
        {items.error && (
          <Callout.Root color="amber" mt="4">
            <Callout.Text>
              {errorText(items.error)}{" "}
              <Button variant="ghost" onClick={() => void items.refetch()}>
                <RotateCcw size={14} /> Retry
              </Button>
            </Callout.Text>
          </Callout.Root>
        )}
        {items.data?.deliveries.length === 0 && (
          <div className="outbox-empty">
            <Inbox size={30} strokeWidth={1.25} />
            <h3>Nothing sent. Everything in your control.</h3>
            <p>Your summary will appear here when you choose to save or email it.</p>
          </div>
        )}
        {items.data?.deliveries.map((item) => (
          <article key={item.id} className="outbox-item">
            <Badge>{deliveryLabels[item.status] ?? item.status}</Badge>
            <Text as="p" size="2" color="gray" mt="2">
              To {item.recipient} · Summary {item.summaryVersion}
            </Text>
            <div className="summary-text">
              <ReplyText text={item.body} />
            </div>
          </article>
        ))}
      </Dialog.Content>
    </Dialog.Root>
  );
}

window.addEventListener(
  "keydown",
  () => {
    document.documentElement.dataset.input = "keyboard";
  },
  { capture: true },
);
window.addEventListener(
  "pointerdown",
  () => {
    document.documentElement.dataset.input = "pointer";
  },
  { capture: true },
);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Theme accentColor="grass" grayColor="sand" radius="large" panelBackground="solid">
        <App />
      </Theme>
    </QueryClientProvider>
  </StrictMode>,
);
