import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { RuleViolation, type ConversationState } from "../../domain/conversation.ts";
import type {
  DeliveryRecord,
  SessionAccess,
  SessionRecord,
  SessionStore,
  TurnInput,
  TurnResult,
} from "../../application/session-ports.ts";

type Row = {
  id: string;
  token_hash: string;
  version: number;
  expires_at: number;
  revoked: number;
  state: string;
};
type DeliveryRow = {
  id: string;
  session_id: string;
  subject_id: string;
  summary_version: number;
  recipient: string;
  body: string;
  status: DeliveryRecord["status"];
  created_at: number;
};
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const delivery = (row: DeliveryRow): DeliveryRecord => ({
  id: row.id,
  sessionId: row.session_id,
  subjectId: row.subject_id,
  summaryVersion: row.summary_version,
  recipient: row.recipient,
  body: row.body,
  status: row.status,
  createdAt: row.created_at,
});

export class SqliteSessionStore implements SessionStore {
  readonly #db: Database;
  constructor(path = ":memory:") {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, version INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, result TEXT, PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        subject_id TEXT NOT NULL, summary_version INTEGER NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(session_id,summary_version,recipient));
      UPDATE sessions SET revoked=1;
      UPDATE deliveries SET status='unknown' WHERE status='pending';`);
  }
  create(state: ConversationState, now: number, ttl: number) {
    const access = {
      sessionId: crypto.randomUUID(),
      token: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    };
    this.#db
      .query("INSERT INTO sessions (id,token_hash,version,expires_at,state) VALUES (?,?,0,?,?)")
      .run(access.sessionId, hash(access.token), now + ttl, JSON.stringify(state));
    return { access, record: this.read(access, now) };
  }
  read(access: SessionAccess, now: number): SessionRecord {
    const row = this.#db
      .query<Row, [string]>("SELECT * FROM sessions WHERE id=?")
      .get(access.sessionId);
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash(access.token))))
      throw new RuleViolation("session_not_found");
    if (row.revoked || row.expires_at <= now) throw new RuleViolation("session_expired");
    return {
      id: row.id,
      version: row.version,
      expiresAt: row.expires_at,
      state: JSON.parse(row.state) as ConversationState,
    };
  }
  save(
    access: SessionAccess,
    expectedVersion: number,
    state: ConversationState,
    now: number,
    ttl: number,
  ): SessionRecord {
    return this.#db
      .transaction(() => {
        const current = this.read(access, now);
        if (current.version !== expectedVersion) throw new RuleViolation("version_conflict");
        const changed = this.#db
          .query(
            "UPDATE sessions SET state=?, version=version+1, expires_at=? WHERE id=? AND version=? AND revoked=0",
          )
          .run(JSON.stringify(state), now + ttl, access.sessionId, expectedVersion).changes;
        if (changed !== 1) throw new RuleViolation("version_conflict");
        return this.read(access, now);
      })
      .immediate();
  }
  revoke(access: SessionAccess, now: number): void {
    this.read(access, now);
    this.#db
      .query("UPDATE sessions SET revoked=1, version=version+1 WHERE id=?")
      .run(access.sessionId);
  }
  beginRequest(access: SessionAccess, input: TurnInput, now: number): TurnResult | null {
    return this.#db
      .transaction(() => {
        this.read(access, now);
        const fingerprint = hash(
          JSON.stringify({ text: input.text, action: input.action ?? null }),
        );
        const row = this.#db
          .query<{ fingerprint: string; result: string | null }, [string, string]>(
            "SELECT fingerprint,result FROM requests WHERE session_id=? AND id=?",
          )
          .get(access.sessionId, input.requestId);
        if (row) {
          if (row.fingerprint !== fingerprint) throw new RuleViolation("request_id_conflict");
          if (row.result === null) throw new RuleViolation("request_in_progress");
          return JSON.parse(row.result) as TurnResult;
        }
        this.#db
          .query("INSERT INTO requests(session_id,id,fingerprint) VALUES (?,?,?)")
          .run(access.sessionId, input.requestId, fingerprint);
        return null;
      })
      .immediate();
  }
  finishRequest(access: SessionAccess, result: TurnResult, now: number): void {
    this.read(access, now);
    this.#db
      .query("UPDATE requests SET result=? WHERE session_id=? AND id=? AND result IS NULL")
      .run(JSON.stringify(result), access.sessionId, result.requestId);
  }
  reserveDelivery(
    access: SessionAccess,
    expectedVersion: number,
    now: number,
  ): { record: DeliveryRecord; attempt: boolean } {
    return this.#db
      .transaction(() => {
        const current = this.read(access, now);
        if (current.version !== expectedVersion) throw new RuleViolation("version_conflict");
        const { emailConsent: consent, summary, phase } = current.state;
        if (
          phase !== "POST_PROCESS" ||
          consent.status !== "granted" ||
          !summary ||
          consent.summaryVersion !== summary.version
        )
          throw new RuleViolation("current_summary_consent_required");
        const subjectId = current.state.selectedCase?.value.subjectId;
        if (!subjectId) throw new RuleViolation("case_unavailable");
        const existing = this.#db
          .query<DeliveryRow, [string, number, string]>(
            "SELECT * FROM deliveries WHERE session_id=? AND summary_version=? AND recipient=?",
          )
          .get(access.sessionId, summary.version, consent.recipient);
        if (existing) {
          const attempt = existing.status === "failed";
          if (attempt)
            this.#db
              .query("UPDATE deliveries SET status='pending' WHERE id=? AND status='failed'")
              .run(existing.id);
          return {
            record: {
              ...delivery(existing),
              status: attempt ? ("pending" as const) : existing.status,
            },
            attempt,
          };
        }
        const id = crypto.randomUUID();
        this.#db
          .query("INSERT INTO deliveries VALUES (?,?,?,?,?,?,'pending',?)")
          .run(
            id,
            access.sessionId,
            subjectId,
            summary.version,
            consent.recipient,
            summary.text,
            now,
          );
        return {
          record: {
            id,
            sessionId: access.sessionId,
            subjectId,
            summaryVersion: summary.version,
            recipient: consent.recipient,
            body: summary.text,
            status: "pending" as const,
            createdAt: now,
          },
          attempt: true,
        };
      })
      .immediate();
  }
  updateDelivery(id: string, status: DeliveryRecord["status"]): DeliveryRecord {
    this.#db
      .query(
        "UPDATE deliveries SET status=? WHERE id=? AND status NOT IN ('mock_recorded','submitted')",
      )
      .run(status, id);
    const row = this.#db
      .query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE id=?")
      .get(id);
    if (!row) throw new RuleViolation("delivery_unavailable");
    return delivery(row);
  }
  deliveries(access: SessionAccess, now: number): readonly DeliveryRecord[] {
    this.read(access, now);
    return this.#db
      .query<DeliveryRow, [string]>(
        "SELECT * FROM deliveries WHERE session_id=? ORDER BY created_at",
      )
      .all(access.sessionId)
      .map(delivery);
  }
  close() {
    this.#db.close();
  }
}
