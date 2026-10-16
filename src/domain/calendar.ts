export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) {
    throw new Error("Clock must return valid Unix milliseconds");
  }
}
