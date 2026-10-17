import { SQL } from "bun";
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

type SessionRow = {
  id: string;
  token_hash: string;
  version: number;
  expires_at: number | string;
  revoked: boolean;
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
  created_at: number | string;
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
  createdAt: Number(row.created_at),
});

/** Shared authority survives Vercel cold starts; SQL transactions guard competing instances. */
export class PostgresSessionStore implements SessionStore {
  readonly #sql: SQL;
  readonly #locks: SQL;
  private constructor(url: string) {
    this.#sql = new SQL(url, { max: 10, idleTimeout: 20, connectionTimeout: 15 });
    // Long-running turn locks must not occupy every connection needed for business writes.
    this.#locks = new SQL(url, { max: 10, idleTimeout: 20, connectionTimeout: 15 });
  }

  static async open(url: string): Promise<PostgresSessionStore> {
    const store = new PostgresSessionStore(url);
    try {
      await store.#sql.begin(async (sql) => {
        // Concurrent cold starts must not race PostgreSQL's CREATE TABLE catalog writes.
        await sql`SELECT pg_advisory_xact_lock(1128670019)`;
        await sql`CREATE TABLE IF NOT EXISTS claimflow_sessions (
          id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, version INTEGER NOT NULL,
          expires_at BIGINT NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE, state TEXT NOT NULL)`;
        await sql`CREATE TABLE IF NOT EXISTS claimflow_requests (
          session_id TEXT NOT NULL REFERENCES claimflow_sessions(id) ON DELETE CASCADE,
          id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT, started_at BIGINT NOT NULL,
          PRIMARY KEY(session_id,id))`;
        await sql`CREATE TABLE IF NOT EXISTS claimflow_deliveries (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES claimflow_sessions(id) ON DELETE CASCADE,
          subject_id TEXT NOT NULL, summary_version INTEGER NOT NULL, recipient TEXT NOT NULL,
          body TEXT NOT NULL, status TEXT NOT NULL, created_at BIGINT NOT NULL,
          UNIQUE(session_id,summary_version,recipient))`;
        await sql`CREATE TABLE IF NOT EXISTS claimflow_cancellations (
          session_id TEXT NOT NULL REFERENCES claimflow_sessions(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL, PRIMARY KEY(session_id,request_id))`;
      });
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async #read(sql: SQL, access: SessionAccess, now: number, lock = false): Promise<SessionRecord> {
    const rows = lock
      ? await sql<
          SessionRow[]
        >`SELECT * FROM claimflow_sessions WHERE id=${access.sessionId} FOR UPDATE`
      : await sql<SessionRow[]>`SELECT * FROM claimflow_sessions WHERE id=${access.sessionId}`;
    const row = rows[0];
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash(access.token))))
      throw new RuleViolation("session_not_found");
    if (row.revoked || Number(row.expires_at) <= now) throw new RuleViolation("session_expired");
    return {
      id: row.id,
      version: row.version,
      expiresAt: Number(row.expires_at),
      state: JSON.parse(row.state) as ConversationState,
    };
  }

  async create(state: ConversationState, now: number, ttl: number) {
    const access = {
      sessionId: crypto.randomUUID(),
      token: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    };
    await this.#sql`DELETE FROM claimflow_sessions WHERE expires_at < ${now - 86_400_000}`;
    await this.#sql`INSERT INTO claimflow_sessions (id,token_hash,version,expires_at,state)
      VALUES (${access.sessionId},${hash(access.token)},0,${now + ttl},${JSON.stringify(state)})`;
    return { access, record: await this.read(access, now) };
  }

  read(access: SessionAccess, now: number) {
    return this.#read(this.#sql, access, now);
  }

  async save(
    access: SessionAccess,
    expectedVersion: number,
    state: ConversationState,
    now: number,
    ttl: number,
  ) {
    await this.read(access, now);
    const changed = await this.#sql<{ id: string }[]>`UPDATE claimflow_sessions
      SET state=${JSON.stringify(state)}, version=version+1, expires_at=${now + ttl}
      WHERE id=${access.sessionId} AND version=${expectedVersion} AND NOT revoked AND expires_at>${now}
      RETURNING id`;
    if (!changed.length) {
      await this.read(access, now);
      throw new RuleViolation("version_conflict");
    }
    return this.read(access, now);
  }

  async revoke(access: SessionAccess, now: number) {
    await this.read(access, now);
    await this
      .#sql`UPDATE claimflow_sessions SET revoked=TRUE, version=version+1 WHERE id=${access.sessionId}`;
  }

  async withSessionLock<T>(access: SessionAccess, work: () => Promise<T>): Promise<T> {
    return this.#locks.begin(async (sql) => {
      // A transaction lock also works behind Neon's transaction-mode pooler.
      const [row] = await sql<
        { acquired: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtextextended(${access.sessionId}, 0)) AS acquired`;
      if (!row?.acquired) throw new RuleViolation("request_in_progress");
      return work();
    }) as Promise<T>;
  }

  async beginRequest(
    access: SessionAccess,
    input: TurnInput,
    now: number,
  ): Promise<TurnResult | null> {
    const fingerprint = hash(JSON.stringify({ text: input.text, action: input.action ?? null }));
    return this.#sql.begin(async (sql) => {
      await this.#read(sql, access, now, true);
      const [row] = await sql<
        { fingerprint: string; result: string | null; started_at: number | string }[]
      >`
        SELECT fingerprint,result,started_at FROM claimflow_requests WHERE session_id=${access.sessionId} AND id=${input.requestId}`;
      if (row) {
        if (row.fingerprint !== fingerprint) throw new RuleViolation("request_id_conflict");
        if (row.result !== null) return JSON.parse(row.result) as TurnResult;
        if (Number(row.started_at) + 120_000 > now) throw new RuleViolation("request_in_progress");
        // Interrupted workers may retry after their bounded run has ended. Delivery IDs remain durable.
        await sql`UPDATE claimflow_requests SET started_at=${now} WHERE session_id=${access.sessionId} AND id=${input.requestId}`;
        return null;
      }
      await sql`INSERT INTO claimflow_requests(session_id,id,fingerprint,started_at)
        VALUES (${access.sessionId},${input.requestId},${fingerprint},${now})`;
      return null;
    });
  }

  async finishRequest(access: SessionAccess, result: TurnResult, now: number) {
    await this.read(access, now);
    await this.#sql`UPDATE claimflow_requests SET result=${JSON.stringify(result)}
      WHERE session_id=${access.sessionId} AND id=${result.requestId} AND result IS NULL`;
  }

  async reserveDelivery(access: SessionAccess, expectedVersion: number, now: number) {
    return this.#sql.begin(async (sql) => {
      const current = await this.#read(sql, access, now, true);
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
      const [existing] = await sql<DeliveryRow[]>`SELECT * FROM claimflow_deliveries
        WHERE session_id=${access.sessionId} AND summary_version=${summary.version} AND recipient=${consent.recipient}`;
      if (existing) {
        const attempt = existing.status === "failed";
        if (attempt)
          await sql`UPDATE claimflow_deliveries SET status='pending' WHERE id=${existing.id} AND status='failed'`;
        return {
          record: {
            ...delivery(existing),
            status: attempt ? ("pending" as const) : existing.status,
          },
          attempt,
        };
      }
      const id = crypto.randomUUID();
      await sql`INSERT INTO claimflow_deliveries VALUES
        (${id},${access.sessionId},${subjectId},${summary.version},${consent.recipient},${summary.text},'pending',${now})`;
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
    });
  }

  async updateDelivery(id: string, status: DeliveryRecord["status"]) {
    await this.#sql`UPDATE claimflow_deliveries SET status=${status}
      WHERE id=${id} AND status NOT IN ('mock_recorded','submitted')`;
    const [row] = await this.#sql<DeliveryRow[]>`SELECT * FROM claimflow_deliveries WHERE id=${id}`;
    if (!row) throw new RuleViolation("delivery_unavailable");
    return delivery(row);
  }

  async deliveries(access: SessionAccess, now: number) {
    await this.read(access, now);
    const rows = await this.#sql<
      DeliveryRow[]
    >`SELECT * FROM claimflow_deliveries WHERE session_id=${access.sessionId} ORDER BY created_at`;
    return rows.map(delivery);
  }

  async cancelRequest(access: SessionAccess, requestId: string, now: number) {
    await this.read(access, now);
    await this
      .#sql`INSERT INTO claimflow_cancellations VALUES (${access.sessionId},${requestId}) ON CONFLICT DO NOTHING`;
  }

  async isRequestCancelled(access: SessionAccess, requestId: string) {
    const rows = await this
      .#sql`SELECT 1 FROM claimflow_cancellations WHERE session_id=${access.sessionId} AND request_id=${requestId}`;
    return rows.length > 0;
  }

  async close() {
    await Promise.all([this.#locks.close(), this.#sql.close()]);
  }
}
