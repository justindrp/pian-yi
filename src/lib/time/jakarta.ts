import { isClosedHoliday } from "@/lib/holidays/id";
import { jakartaDateString } from "@/lib/menu/week";

// Wall-clock time in the timezone the business runs on.
//
// The customer prompt used to state the calendar date and the order deadline
// hour and nothing else — no clock. On 2026-08-20 at 19:05 WIB, three hours
// after the 16:00 cutoff, a new customer asked to start "besok, kan Jumat" and
// the bot said yes. It had no way to know the cutoff had passed: it was handed
// a rule and never the reading to compare it against.
//
// The date line had a second defect. It was built with
// `new Date().toLocaleDateString("id-ID")` and no timeZone, and Railway runs
// UTC, so between 00:00 and 07:00 WIB the prompt asserted yesterday's date.

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000; // WIB, UTC+7 — no DST

/** HH:MM in Jakarta, 24-hour. */
export function jakartaTimeString(at: Date = new Date()): string {
  return new Date(at.getTime() + JAKARTA_OFFSET_MS).toISOString().slice(11, 16);
}

/** Hour of day in Jakarta, 0–23. */
export function jakartaHour(at: Date = new Date()): number {
  return Number(jakartaTimeString(at).slice(0, 2));
}

/** `ymd` shifted by `n` days, still as Y-m-d. */
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True when a date is one we deliver on: not Minggu, not a libur nasional. */
export function isDeliveryDay(ymd: string): boolean {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return dow !== 0 && !isClosedHoliday(ymd);
}

/**
 * The soonest date we can still promise, given the H-1 cutoff.
 *
 * Tomorrow while the cutoff is still ahead, the day after once it has passed,
 * then forward past Minggu and any closure. Callers get a date they can quote
 * without doing the arithmetic themselves — which is the part the model got
 * wrong.
 */
export function earliestDeliveryDate(opts: {
  deadlineHour: number;
  now?: Date;
}): { date: string; deadlinePassed: boolean } {
  const now = opts.now ?? new Date();
  const today = jakartaDateString(now);
  const deadlinePassed = jakartaHour(now) >= opts.deadlineHour;

  let date = addDays(today, deadlinePassed ? 2 : 1);
  // 60 is arbitrary but far past any real run of closures; it only exists so a
  // bad holiday table cannot spin here forever.
  for (let i = 0; i < 60 && !isDeliveryDay(date); i++) {
    date = addDays(date, 1);
  }
  return { date, deadlinePassed };
}
