import type { Phase, SopState } from "../domain/conversation.ts";
import type { BusinessToolName } from "./tool-contracts.ts";

/** Server-side audit projection. Never contains arguments, PII, identifiers, or model text. */
export type BusinessObservation =
  | {
      readonly type: "state_transition";
      readonly from: Phase;
      readonly to: Phase;
      readonly version: number;
      readonly status: SopState["status"];
      readonly verified: boolean;
      readonly distinctMatches: number;
      readonly summaryVersion: number | null;
    }
  | {
      readonly type: "tool_outcome";
      readonly tool: BusinessToolName | "unknown";
      readonly phase: Phase;
      readonly verified: boolean;
      readonly currentEmailConsent: boolean;
      readonly outcome: "success" | "denied" | "error";
      readonly reason: string | null;
    };

export function observe(
  sink: ((event: BusinessObservation) => void) | undefined,
  event: BusinessObservation,
): void {
  // Diagnostics must not change business behavior or turn a committed side effect into a retry.
  try {
    sink?.(event);
  } catch {
    /* The caller owns diagnostic sink availability. */
  }
}
