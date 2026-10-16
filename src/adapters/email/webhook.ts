import type { DeliveryRecord, EmailSender } from "../../application/session-ports.ts";

/** The configured gateway must honor Idempotency-Key and expose GET /deliveries/:id receipts. */
export function webhookEmail(baseUrl: string, token: string): EmailSender {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("EMAIL_WEBHOOK_URL must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("EMAIL_WEBHOOK_URL must use HTTP(S) without URL credentials.");
  if (!token.trim()) throw new Error("EMAIL_WEBHOOK_TOKEN is required for webhook email.");
  const status = async (response: Response): Promise<"submitted" | "failed" | "unknown"> => {
    if (!response.ok) return "unknown";
    const value: unknown = await response.json();
    if (value !== null && typeof value === "object" && "status" in value) {
      if (value.status === "submitted" || value.status === "failed") return value.status;
    }
    return "unknown";
  };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    mode: "external",
    async send(record: DeliveryRecord, signal) {
      return status(
        await fetch(new URL("deliveries", `${url.href.replace(/\/$/, "")}/`), {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": record.id },
          body: JSON.stringify({
            id: record.id,
            to: record.recipient,
            subject: "Your claim support summary",
            text: record.body,
          }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        }),
      );
    },
    async reconcile(record) {
      return status(
        await fetch(
          new URL(`deliveries/${encodeURIComponent(record.id)}`, `${url.href.replace(/\/$/, "")}/`),
          { headers, signal: AbortSignal.timeout(15_000) },
        ),
      );
    },
  };
}
