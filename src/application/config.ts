import { DEFAULT_SOP_POLICY, type SopPolicy } from "../domain/conversation.ts";

const POLICY_ENV = {
  maxIdentityFailures: "MAX_IDENTITY_FAILURES",
  maxConsecutiveOffTopic: "MAX_CONSECUTIVE_OFF_TOPIC",
  authorizationTimeoutMs: "AUTHORIZATION_TIMEOUT_MS",
  sessionIdleTimeoutMs: "SESSION_IDLE_TIMEOUT_MS",
} as const satisfies Record<keyof SopPolicy, string>;

export function readSopPolicy(env: Readonly<Record<string, string | undefined>>): SopPolicy {
  const policy = { ...DEFAULT_SOP_POLICY };
  for (const key of Object.keys(POLICY_ENV) as (keyof SopPolicy)[]) {
    const name = POLICY_ENV[key];
    const raw = env[name];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value))
      throw new Error(`${name} must be a positive safe integer`);
    policy[key] = value;
  }
  return Object.freeze(policy);
}
