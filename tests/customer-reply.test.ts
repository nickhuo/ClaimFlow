import { expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { piReplyComposer } from "../src/adapters/pi/reply-composer.ts";
import type { CustomerReply, PublicEvent } from "../src/application/session-ports.ts";
import { sample, setup } from "./helpers/conversation.ts";

test("the customer composer receives authorized facts without identity values and its answer is replayed exactly", async () => {
  const inputs: CustomerReply[] = [];
  const { service } = await setup(0, {
    replyComposer: {
      async compose(input) {
        inputs.push(input);
        return "The missing pathology report and office note explain why claim CL-2048 was denied. The recorded deadline 2026-03-18 has passed; an extension is not confirmed.";
      },
    },
  });
  try {
    const access = service.create();
    const input = { requestId: "natural-answer", text: sample };
    const answer = await service.turn(access, input);
    expect(answer.error).toBeNull();
    expect(answer.reply).toStartWith("The missing pathology report");
    expect(inputs[0]!.approvedResponse).toContain("CL-2048");
    for (const privateValue of ["Margaret Chen", "1985-03-15", "4472", "POL-9921"])
      expect(JSON.stringify(inputs)).not.toContain(privateValue);
    expect(await service.turn(access, input)).toEqual(answer);
    expect(inputs).toHaveLength(1);
  } finally {
    await service.close();
  }
});

test("unverified and out-of-scope turns expose only their approved response to the wording model", async () => {
  const inputs: CustomerReply[] = [];
  const { service } = await setup(0, {
    replyComposer: {
      async compose(input) {
        inputs.push(input);
        return "I can help with your insurance claim. Before discussing details, we need to verify your identity.";
      },
    },
  });
  try {
    const access = service.create();
    await service.turn(access, { requestId: "unverified", text: "Why was my claim denied?" });
    await service.turn(access, { requestId: "unrelated", text: "What is RL?" });
    expect(inputs[0]!.approvedResponse).toContain("three different identity details");
    expect(inputs[1]!.approvedResponse).toContain("claim-related question");
    for (const input of inputs) {
      expect(input.approvedResponse).not.toContain("CL-2048");
      expect(input.approvedResponse).not.toContain("pathology");
    }
  } finally {
    await service.close();
  }
});

for (const unsafe of [
  "Your SSN ends in 4472.",
  "Your policy is POL-9921.",
  "We paid USD 999.00.",
  "See CL-8888.",
  "Email agent@fake.example.",
  "The requested documents are missing.",
]) {
  test(`unsupported customer output is discarded: ${unsafe}`, async () => {
    const { service } = await setup(0, {
      replyComposer: {
        async compose() {
          return unsafe;
        },
      },
    });
    try {
      const access = service.create();
      const answer = await service.turn(access, { requestId: "unsafe", text: sample });
      expect(answer.error).toBe("model_unavailable");
      expect(answer.reply).not.toContain(unsafe);
      expect(answer.reply).toContain("couldn't finish");
      expect(answer.view.verified).toBe(true);
    } finally {
      await service.close();
    }
  });
}

test("cancelling a response during composition drops late text and retains confirmed progress", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { service } = await setup(0, {
    replyComposer: {
      async compose() {
        started.resolve();
        await release.promise;
        return "LATE_COMPOSER_TEXT";
      },
    },
  });
  try {
    const access = service.create();
    const answer = service.turn(access, { requestId: "cancel", text: sample });
    await started.promise;
    await service.cancel(access, "cancel");
    release.resolve();
    const result = await answer;
    expect(result.error).toBe("cancelled");
    expect(result.reply).not.toContain("LATE_COMPOSER_TEXT");
    expect(result.view.verified).toBe(true);
  } finally {
    release.resolve();
    await service.close();
  }
});

test("reset during composition prevents any old-session reply from being published", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: PublicEvent[] = [];
  const { service } = await setup(0, {
    replyComposer: {
      async compose() {
        started.resolve();
        await release.promise;
        return "LATE_COMPOSER_TEXT";
      },
    },
  });
  try {
    const access = service.create();
    const answer = service
      .turn(access, { requestId: "reset", text: sample }, (event) => events.push(event))
      .catch((error: Error) => error);
    await started.promise;
    const fresh = await service.reset(access);
    release.resolve();
    expect(await answer).toBeInstanceOf(Error);
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(service.view(fresh).verified).toBe(false);
  } finally {
    release.resolve();
    await service.close();
  }
});

test("the Pi wording call has no tools or transcript, hides thinking, and records usage", async () => {
  const faux = fauxProvider({ provider: "reply-test", models: [{ id: "writer" }] });
  const traces: string[] = [];
  faux.setResponses([
    (context, options) => {
      expect(options?.apiKey).toBe("LOCAL_TEST_CREDENTIAL");
      expect(context.messages).toHaveLength(2);
      expect(JSON.stringify(context)).not.toContain("LOCAL_TEST_CREDENTIAL");
      expect(
        context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded ?? []) : [],
        ),
      ).toEqual([]);
      return fauxAssistantMessage([
        fauxThinking("PRIVATE_REASONING"),
        { type: "text", text: "Let's check the remaining details together." },
      ]);
    },
  ]);
  const composer = piReplyComposer(
    { provider: faux.provider, modelId: "writer", apiKey: "LOCAL_TEST_CREDENTIAL" },
    (event) => traces.push(event.type),
  );
  const input = { question: "Why?", approvedResponse: "Identity verification is required." };
  const reply = await composer.compose(input, new AbortController().signal);
  expect(reply).toBe("Let's check the remaining details together.");
  expect(traces).toEqual(["model_request", "model_usage"]);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("send_summary", {}))]);
  await expect(composer.compose(input, new AbortController().signal)).rejects.toThrow(
    "customer_reply_unavailable",
  );
});
