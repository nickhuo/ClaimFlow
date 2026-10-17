import { isCalendarDate } from "./calendar.ts";

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthPattern =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const dayPattern = "\\d{1,2}(?:st|nd|rd|th)?";
const monthFirst = `(${monthPattern})\\.?\\s+(${dayPattern})(?:,\\s*|\\s+)(\\d{4})`;
const dayFirst = `(${dayPattern})\\s+(?:of\\s+)?(${monthPattern})\\.?(?:,\\s*|\\s+)(\\d{4})`;

function calendarDate(year: number, month: number, day: number): string | null {
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return year > 0 && isCalendarDate(iso) ? iso : null;
}

/** Parse only complete dates with one interpretation; never use locale-dependent Date.parse. */
export function normalizeDateOfBirth(value: string): string | null {
  const text = value.normalize("NFKC").trim().toLowerCase();
  const yearFirst = text.match(/^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/);
  if (yearFirst)
    return calendarDate(Number(yearFirst[1]), Number(yearFirst[3]), Number(yearFirst[4]));
  const namedMonthFirst = text.match(new RegExp(`^${monthFirst}$`, "i"));
  if (namedMonthFirst)
    return calendarDate(
      Number(namedMonthFirst[3]),
      months.indexOf(namedMonthFirst[1]!.slice(0, 3)) + 1,
      parseInt(namedMonthFirst[2]!, 10),
    );
  const namedDayFirst = text.match(new RegExp(`^${dayFirst}$`, "i"));
  if (namedDayFirst)
    return calendarDate(
      Number(namedDayFirst[3]),
      months.indexOf(namedDayFirst[2]!.slice(0, 3)) + 1,
      parseInt(namedDayFirst[1]!, 10),
    );
  const yearLast = text.match(/^(\d{1,2})([-/])(\d{1,2})\2(\d{4})$/);
  if (!yearLast) return null;
  const [, first, , second, year] = yearLast;
  const candidates = new Set(
    [
      calendarDate(Number(year), Number(first), Number(second)),
      calendarDate(Number(year), Number(second), Number(first)),
    ].filter((candidate) => candidate !== null),
  );
  return candidates.size === 1 ? [...candidates][0]! : null;
}

/** Whole date expressions in caller text, including invalid/ambiguous ones needing clarification. */
export function dateOfBirthMentions(text: string): string[] {
  const numeric = "(?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[-/]\\d{1,2}[-/]\\d{4})";
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}/-])(?:${numeric}|${monthFirst}|${dayFirst})(?![\\p{L}\\p{N}/-])`,
    "giu",
  );
  return [...text.matchAll(pattern)].map(([value]) => value);
}
