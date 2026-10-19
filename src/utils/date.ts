/**
 * Returns the local timezone offset as ±HH:MM string at the given instant
 * (default: now). Passing the instant matters across DST changes.
 * e.g. Argentina (UTC-3) → "-03:00", Japan (UTC+9) → "+09:00"
 */
export function getLocalOffset(at: Date = new Date()): string {
  const offsetMin = at.getTimezoneOffset(); // minutes, positive = behind UTC
  const sign = offsetMin <= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `${sign}${h}:${m}`;
}

export function getWhoopDay(): string {
  return formatDateLocal(new Date());
}

export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function formatDateLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Build start/end timestamps for a local calendar day.
 * Uses the system timezone so "2026-03-03" in Argentina (UTC-3)
 * becomes start: "2026-03-03T00:00:00.000-03:00" (= 03:00 UTC).
 */
export function getDateRange(date: string): { start: string; end: string } {
  return { start: toLocalStart(date), end: toLocalEnd(date) };
}

function localDateTime(date: string, h: number, m: number, s: number): Date {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m, s);
}

/**
 * Append that day's local timezone offset to a bare date for use as a start timestamp.
 */
export function toLocalStart(date: string): string {
  return `${date}T00:00:00.000${getLocalOffset(localDateTime(date, 0, 0, 0))}`;
}

/**
 * Append that day's local timezone offset to a bare date for use as an end timestamp.
 */
export function toLocalEnd(date: string): string {
  return `${date}T23:59:59.999${getLocalOffset(localDateTime(date, 23, 59, 59))}`;
}

/** True for a real calendar date in YYYY-MM-DD form (rejects e.g. 2026-02-31). */
export function validateISODate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function getDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return formatDateLocal(d);
}
