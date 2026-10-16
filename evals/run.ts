import { mkdir } from "node:fs/promises";
import { loadFixtureData } from "../src/adapters/fixtures/index.ts";
import { SqliteSessionStore } from "../src/adapters/sqlite/store.ts";
import { mockAuthorization } from "../src/adapters/authorization/mock.ts";
import { mockEmail } from "../src/adapters/email/mock.ts";
import { demoProvider } from "../src/adapters/pi/demo-provider.ts";
import { modelConfiguration } from "../src/adapters/pi/provider.ts";
import { piHarnessFactory, type PiObservation } from "../src/adapters/pi/harness.ts";
import { ConversationService } from "../src/application/sessions.ts";
import { DEFAULT_SOP_POLICY, type Phase } from "../src/domain/conversation.ts";
import type { BusinessObservation } from "../src/application/telemetry.ts";
import { SYSTEM_PROMPT } from "../src/application/conversation/prompt.ts";
import { BUSINESS_TOOL_SCHEMAS } from "../src/application/tool-contracts.ts";
import { scenarios } from "./scenarios.ts";
import { verifyStep } from "./verify.ts";

async function versions() {
  const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const root = new URL("../", import.meta.url).pathname;
  const files = [...new Bun.Glob("fixtures/*.json").scanSync({ cwd: root })].sort();
  const contents = await Promise.all(files.map((file) => Bun.file(`${root}${file}`).text()));
  const implementationFiles = [
    ...new Bun.Glob("{src,evals}/**/*.{ts,tsx}").scanSync({ cwd: root }),
  ].sort();
  const implementation = await Promise.all(
    implementationFiles.map(async (file) => `${file}\n${await Bun.file(`${root}${file}`).text()}`),
  );
  const packageJson = await Bun.file(`${root}package.json`).json();
  return {
    sdk: packageJson.dependencies["@earendil-works/pi-coding-agent"],
    bun: Bun.version,
    fixtures: hash(contents.join("\n")),
    prompt: hash(SYSTEM_PROMPT),
    tools: hash(JSON.stringify(BUSINESS_TOOL_SCHEMAS)),
    policy: hash(JSON.stringify(DEFAULT_SOP_POLICY)),
    scenarios: hash(JSON.stringify(scenarios)),
    implementation: hash(implementation.join("\n")),
  };
}

export async function evaluate(
  live: boolean,
  options: {
    repeat?: number;
    scenario?: string;
    onProgress?: (progress: {
      scenario: string;
      step: string;
      passed: boolean;
      failure: string | null;
      durationMs: number;
    }) => void;
  } = {},
) {
  const repeat = options.repeat ?? 1;
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10)
    throw new Error("Evaluation repeat must be between 1 and 10.");
  const selected = scenarios.filter(
    (scenario) => !options.scenario || scenario.name === options.scenario,
  );
  if (!selected.length) throw new Error("Evaluation scenario was not found.");
  const configured = live ? modelConfiguration(process.env) : null;
  const versionSnapshot = await versions();
  const clock = { now: () => Date.parse("2026-10-15T12:00:00Z") };
  const data = await loadFixtureData({ clock });
  const trajectory: PiObservation[] = [];
  const observations: BusinessObservation[] = [];
  const service = new ConversationService(
    {
      data,
      clock,
      store: new SqliteSessionStore(),
      email: mockEmail(),
      authorization: mockAuthorization(data),
      policy: DEFAULT_SOP_POLICY,
      observe: (event) => {
        if (observations.length < 1000) observations.push(event);
      },
    },
    piHarnessFactory({
      cwd: process.cwd(),
      provider: configured ? () => configured : demoProvider,
      trace: (event) => {
        if (trajectory.length < 2000) trajectory.push(event);
      },
    }),
  );
  const results: unknown[] = [];
  let failures = 0;
  try {
    for (let repetition = 1; repetition <= repeat; repetition++)
      for (const scenario of selected) {
        trajectory.length = 0;
        observations.length = 0;
        const access = service.create();
        const steps: unknown[] = [];
        for (const [index, step] of scenario.steps.entries()) {
          const observationStart = observations.length;
          const traceStart = trajectory.length;
          const phases: Phase[] = [];
          const started = performance.now();
          const result = await service.turn(
            access,
            { requestId: `step-${index}`, text: step.text },
            (event) => {
              if (event.type === "progress" && phases.at(-1) !== event.phase)
                phases.push(event.phase);
            },
          );
          const durationMs = Math.round(performance.now() - started);
          const business = observations.slice(observationStart);
          const metrics = trajectory.slice(traceStart);
          const score = verifyStep(step, result, business);
          options.onProgress?.({
            scenario: scenario.name,
            step: step.label,
            passed: score.failure === null,
            failure: score.failure,
            durationMs,
          });
          failures += score.checks.filter((check) => !check.passed).length;
          const usage = metrics.filter((event) => event.type === "model_usage");
          steps.push({
            label: step.label,
            phases,
            finalPhase: result.view.phase,
            status: result.view.status,
            error: result.error,
            ...score,
            metrics: {
              durationMs,
              modelRequests: metrics.filter((event) => event.type === "model_request").length,
              toolCalls: business.filter((event) => event.type === "tool_outcome").length,
              blockedCalls: metrics.filter((event) => event.type === "tool_blocked").length,
              maxProjectionCharacters: Math.max(
                0,
                ...metrics.map((event) => event.projectionCharacters ?? 0),
              ),
              inputTokens: usage.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0),
              cacheReadTokens: usage.reduce((sum, event) => sum + (event.cachedTokens ?? 0), 0),
              cacheWriteTokens: usage.reduce(
                (sum, event) => sum + (event.cacheWriteTokens ?? 0),
                0,
              ),
              outputTokens: usage.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0),
              estimatedCostUsd:
                usage.length &&
                usage.every(
                  (event) =>
                    event.estimatedCostUsd !== null && event.estimatedCostUsd !== undefined,
                )
                  ? usage.reduce((sum, event) => sum + event.estimatedCostUsd!, 0)
                  : null,
            },
            businessTrajectory: business,
            sdkTrajectory: metrics,
          });
        }
        const record = service.dependencies.store.read(access, clock.now());
        const deliveries = service.dependencies.store.deliveries(access, clock.now());
        const checks = [
          { id: "delivery-count", passed: deliveries.length === scenario.deliveries },
          {
            id: "distinct-delivery-ids",
            passed: new Set(deliveries.map((item) => item.id)).size === deliveries.length,
          },
          {
            id: "evidence-provenance",
            passed: record.state.identityAudit.every(
              (item) => item.turnId && item.sources.length > 0,
            ),
          },
        ];
        failures += checks.filter((check) => !check.passed).length;
        results.push({ name: scenario.name, repetition, steps, checks });
      }
  } finally {
    await service.close();
  }
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    mode: live ? "live-model" : "deterministic-provider",
    versions: versionSnapshot,
    provider: configured?.provider.id ?? "demo",
    model: configured?.modelId ?? "scripted-insurance",
    thinkingLevel: configured?.thinkingLevel ?? "off",
    fixtureClock: new Date(clock.now()).toISOString(),
    repeat,
    costBasis:
      "Pinned SDK catalog estimate, not an invoice. Null means unavailable; demo costs are not real.",
    passed: failures === 0,
    failures,
    scenarios: results,
  };
}
if (import.meta.main) {
  const live = process.argv.includes("--live");
  try {
    const value = (flag: string) => {
      const index = process.argv.indexOf(flag);
      return index >= 0 ? process.argv[index + 1] : undefined;
    };
    const scenario = value("--scenario");
    const report = await evaluate(live, {
      repeat: Number(value("--repeat") ?? 1),
      ...(scenario ? { scenario } : {}),
      ...(live ? { onProgress: (progress: unknown) => console.log(JSON.stringify(progress)) } : {}),
    });
    await mkdir("artifacts", { recursive: true });
    const path = `artifacts/eval-${live ? "live" : "deterministic"}.json`;
    await Bun.write(path, JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify({
        mode: report.mode,
        provider: report.provider,
        model: report.model,
        passed: report.passed,
        failures: report.failures,
        report: path,
      }),
    );
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof Error && /^(Configure |MODEL_|Evaluation )/.test(error.message)
        ? error.message
        : "Evaluation could not finish. Check server model configuration and rerun; raw provider errors are withheld.",
    );
    process.exitCode = 1;
  }
}
