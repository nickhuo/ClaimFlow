import { ConversationService } from "../../src/application/sessions.ts";
import { loadFixtureData } from "../../src/adapters/fixtures/index.ts";
import { SqliteSessionStore } from "../../src/adapters/sqlite/store.ts";
import { mockAuthorization } from "../../src/adapters/authorization/mock.ts";
import { mockEmail } from "../../src/adapters/email/mock.ts";
import { piHarnessFactory } from "../../src/adapters/pi/harness.ts";
import { demoProvider } from "../../src/adapters/pi/demo-provider.ts";
import { DEFAULT_SOP_POLICY } from "../../src/domain/conversation.ts";
import type { BusinessDependencies } from "../../src/application/conversation/context.ts";
import type { HarnessFactory } from "../../src/application/session-ports.ts";

export const sample =
  "I'm the policyholder. My name is Margaret Chen, policy POL-9921. I'm calling about my denied healthcare claim from January. DOB is 1985-03-15, SSN last four is 4472.";
export async function setup(
  failures = 0,
  overrides: Partial<BusinessDependencies> = {},
  harness?: HarnessFactory,
) {
  let time = Date.parse("2026-10-15T12:00:00Z");
  const clock = { now: () => time };
  const data = await loadFixtureData({ clock });
  const traces: string[] = [];
  const service = new ConversationService(
    {
      data,
      clock,
      store: overrides.store ?? new SqliteSessionStore(),
      email: mockEmail(failures),
      authorization: mockAuthorization(data),
      policy: DEFAULT_SOP_POLICY,
      ...overrides,
    },
    harness ??
      piHarnessFactory({
        cwd: process.cwd(),
        provider: demoProvider,
        trace: (event) => traces.push(event.type),
      }),
  );
  return {
    service,
    traces,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
