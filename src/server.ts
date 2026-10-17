import { mkdir, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtureData } from "./adapters/fixtures/index.ts";
import { SqliteSessionStore } from "./adapters/sqlite/store.ts";
import { mockAuthorization } from "./adapters/authorization/mock.ts";
import { mockEmail } from "./adapters/email/mock.ts";
import { webhookEmail } from "./adapters/email/webhook.ts";
import { demoProvider } from "./adapters/pi/demo-provider.ts";
import { modelConfiguration } from "./adapters/pi/provider.ts";
import { piReplyComposer } from "./adapters/pi/reply-composer.ts";
import { piHarnessFactory } from "./adapters/pi/harness.ts";
import { createHttpHandler } from "./adapters/http/handler.ts";
import { ConversationService } from "./application/sessions.ts";
import { readSopPolicy } from "./application/config.ts";
import { buildUi } from "../scripts/build-ui.ts";

export async function startServer(env: Readonly<Record<string, string | undefined>> = process.env) {
  const mode = env.AGENT_MODE ?? "live";
  if (mode !== "demo" && mode !== "live") throw new Error("AGENT_MODE must be demo or live.");
  const configured = mode === "live" ? modelConfiguration(env) : null;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT must be an integer from 0 to 65535.");
  const policy = readSopPolicy(env);
  const emailMode = env.EMAIL_MODE ?? "mock";
  if (emailMode !== "mock" && emailMode !== "webhook")
    throw new Error("EMAIL_MODE must be mock or webhook.");
  const failures = Number(env.EMAIL_MOCK_FAILURES ?? 0);
  if (!Number.isSafeInteger(failures) || failures < 0)
    throw new Error("EMAIL_MOCK_FAILURES must be a nonnegative integer.");
  const email =
    emailMode === "webhook"
      ? webhookEmail(env.EMAIL_WEBHOOK_URL ?? "", env.EMAIL_WEBHOOK_TOKEN ?? "")
      : mockEmail(failures);
  const clock = { now: Date.now };
  const data = await loadFixtureData({ clock });
  const scenario = env.AUTHORIZATION_SCENARIO ?? "default";
  if (!(await data.getConsentScenario(scenario)))
    throw new Error("AUTHORIZATION_SCENARIO must name a fixture scenario.");
  if (!(await Bun.file(`${root}dist/app.js`).exists()) || env.NODE_ENV !== "production")
    await buildUi();
  const assets = new Map<string, { body: Uint8Array; type: string }>();
  for (const [path, file, type] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/assets/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/assets/app.css", "app.css", "text/css; charset=utf-8"],
  ]) {
    assets.set(path!, {
      body: new Uint8Array(await Bun.file(`${root}dist/${file}`).arrayBuffer()),
      type: type!,
    });
  }
  const database = resolve(root, env.SESSION_DB_PATH ?? ".data/sessions.sqlite");
  await mkdir(dirname(database), { recursive: true, mode: 0o700 });
  const store = new SqliteSessionStore(database);
  await chmod(database, 0o600);
  const service = new ConversationService(
    {
      data,
      store,
      clock,
      policy,
      email,
      authorization: mockAuthorization(data, scenario),
      ...(configured ? { replyComposer: piReplyComposer(configured) } : {}),
    },
    piHarnessFactory({ cwd: root, provider: configured ? () => configured : demoProvider }),
  );
  try {
    const server = Bun.serve({
      hostname: env.HOST ?? "127.0.0.1",
      port,
      idleTimeout: 120,
      maxRequestBodySize: 24_000,
      fetch: createHttpHandler(service, { mode, email: email.mode }, assets),
      error() {
        return Response.json({ error: "service_unavailable" }, { status: 503 });
      },
    });
    const reaper = setInterval(() => {
      void service.reapExpired();
    }, 30_000);
    reaper.unref();
    let closing = false;
    return {
      server,
      service,
      async close() {
        if (closing) return;
        closing = true;
        clearInterval(reaper);
        server.stop(false);
        await service.close();
        await server.stop(true);
      },
    };
  } catch (error) {
    await service.close();
    throw error;
  }
}

if (import.meta.main) {
  try {
    const app = await startServer();
    console.log(
      `Claims support is listening at ${app.server.url} (${process.env.AGENT_MODE ?? "live"} mode)`,
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void app.close().then(() => process.exit(0));
      });
  } catch (error) {
    console.error(
      error instanceof Error &&
        /^(Configure |MODEL_|AGENT_MODE|PORT |EMAIL_|AUTHORIZATION_|MAX_|SESSION_)/.test(
          error.message,
        )
        ? error.message
        : "Startup failed. Check configuration, fixture files, port and the session data directory.",
    );
    process.exitCode = 1;
  }
}
