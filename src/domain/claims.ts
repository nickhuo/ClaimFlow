import { assertTimestamp, isCalendarDate } from "./calendar.ts";

export const CASE_TYPES = ["healthcare", "auto", "dental"] as const;
export type CaseType = (typeof CASE_TYPES)[number];
export const AMOUNT_FIELDS = [
  "expected_reimbursement_amount",
  "allowed_max_amount",
  "net_pay",
  "net_fee",
] as const;
export type AmountField = (typeof AMOUNT_FIELDS)[number];
export type Amounts = Readonly<Partial<Record<AmountField, string>>>;

export interface AmountDefinition {
  readonly field: AmountField;
  readonly currency: "USD";
  readonly example: string;
  readonly description: string;
}

export interface CaseHints {
  readonly caseId?: string;
  readonly caseType?: CaseType;
  readonly month?: string;
  readonly claimedStatus?: string;
}

export interface CaseReference {
  readonly caseId: string;
  readonly subjectId: string;
}

export function matchingCases(cases: readonly CaseFacts[], hints: CaseHints): readonly CaseFacts[] {
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const raw = hints.month?.trim().toLowerCase();
  const month =
    raw && months.indexOf(raw) >= 0
      ? String(months.indexOf(raw) + 1).padStart(2, "0")
      : raw?.replace(/^(\d)$/, "0$1");
  const status = hints.claimedStatus?.trim().toLowerCase();
  return cases.filter(
    (item) =>
      (!hints.caseId || item.caseId === hints.caseId) &&
      (!hints.caseType || item.caseType === hints.caseType) &&
      (!month ||
        (month.length === 7
          ? item.createdAt.startsWith(month)
          : item.createdAt.slice(5, 7) === month)) &&
      (!status || item.status.toLowerCase() === status),
  );
}

export interface CaseRecord extends CaseReference {
  readonly caseType: CaseType;
  readonly createdAt: string;
  readonly status: string;
  readonly summary: string;
  readonly denialReason?: string | null;
  readonly documentsNeeded?: readonly string[] | null;
  readonly appealDeadline?: string | null;
  readonly amounts: Amounts;
}

export interface CaseFacts extends CaseReference {
  readonly caseType: CaseType;
  readonly createdAt: string;
  readonly status: string;
  readonly summary: string;
  readonly denialReason: string | null;
  readonly documentsNeeded: readonly string[] | null;
  readonly appealDeadline: string | null;
  readonly appealDeadlineStatus: "not_provided" | "past" | "today" | "future";
  readonly amounts: Amounts;
}

export class CaseInvariantError extends Error {
  constructor(
    readonly field: "createdAt" | "appealDeadline" | "amounts" | "case",
    readonly reason:
      "invalid_date" | "deadline_before_creation" | "invalid_amount" | "invalid_case",
  ) {
    super(`Invalid case ${field}: ${reason}`);
    this.name = "CaseInvariantError";
  }
}

/** An existing case; construction validates its meaning independently of a data source. */
export class Case {
  readonly #record: CaseRecord;

  constructor(record: CaseRecord) {
    if (
      ![record.caseId, record.subjectId, record.status, record.summary].every((value) =>
        value.trim(),
      ) ||
      !CASE_TYPES.includes(record.caseType)
    ) {
      throw new CaseInvariantError("case", "invalid_case");
    }
    if (!isCalendarDate(record.createdAt))
      throw new CaseInvariantError("createdAt", "invalid_date");
    if (record.appealDeadline != null) {
      if (!isCalendarDate(record.appealDeadline))
        throw new CaseInvariantError("appealDeadline", "invalid_date");
      if (record.appealDeadline < record.createdAt)
        throw new CaseInvariantError("appealDeadline", "deadline_before_creation");
    }
    for (const [field, amount] of Object.entries(record.amounts)) {
      if (
        !(AMOUNT_FIELDS as readonly string[]).includes(field) ||
        typeof amount !== "string" ||
        !/^-?\d+\.\d{2}$/.test(amount)
      ) {
        throw new CaseInvariantError("amounts", "invalid_amount");
      }
    }
    this.#record = {
      ...record,
      amounts: { ...record.amounts },
      documentsNeeded: record.documentsNeeded == null ? null : [...record.documentsNeeded],
    };
  }

  belongsTo(subjectId: string): boolean {
    return this.#record.subjectId === subjectId;
  }

  factsAt(now: number): CaseFacts {
    assertTimestamp(now);
    const record = this.#record;
    const deadline = record.appealDeadline ?? null;
    const today = Math.floor(now / 86_400_000);
    const deadlineDay =
      deadline === null ? null : Date.parse(`${deadline}T00:00:00.000Z`) / 86_400_000;
    return {
      caseId: record.caseId,
      subjectId: record.subjectId,
      caseType: record.caseType,
      createdAt: record.createdAt,
      status: record.status,
      summary: record.summary,
      denialReason: record.denialReason ?? null,
      documentsNeeded: record.documentsNeeded == null ? null : [...record.documentsNeeded],
      appealDeadline: deadline,
      appealDeadlineStatus:
        deadlineDay === null
          ? "not_provided"
          : deadlineDay < today
            ? "past"
            : deadlineDay === today
              ? "today"
              : "future",
      amounts: { ...record.amounts },
    };
  }
}
