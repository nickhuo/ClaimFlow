import type { AuthorizationProvider, BusinessData } from "../../application/ports.ts";

/** Explicit simulation. Only the application can supply independently verified caller/subject IDs. */
export function mockAuthorization(
  data: BusinessData,
  scenarioName = "default",
): AuthorizationProvider {
  const polls = new Map<string, number>();
  return {
    async check(request) {
      if (request.now >= request.requestedAt + request.timeoutMs) return { status: "expired" };
      const scenario = await data.getConsentScenario(scenarioName);
      if (!scenario) return { status: "denied" };
      const key = `${request.sessionId}:${request.requestedAt}`;
      const index = polls.get(key) ?? 0;
      polls.set(key, index + 1);
      const status =
        scenario.value.statusSequence[Math.min(index, scenario.value.statusSequence.length - 1)];
      if (status === "approved")
        return {
          status,
          subjectId: request.subjectId,
          representativeId: request.representativeId,
          grantId: `mock:${key}`,
          scope: "claims:read",
          expiresAt: request.now + 30 * 60_000,
          source: "mock",
        };
      return status === "denied"
        ? { status }
        : { status: "pending", requestedAt: request.requestedAt };
    },
  };
}
