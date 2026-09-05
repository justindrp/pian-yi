import {
  BUSINESS_DAYS,
  formatHolidayDate,
  isClosedHoliday,
} from "@/lib/holidays/id";
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

/**
 * Minutes since midnight in Jakarta, 0–1439.
 *
 * Delivery windows are per kitchen and Thenie's lunch ends at 12.30, so an
 * hour is no longer fine enough to say whether the courier is still out.
 */
export function jakartaMinuteOfDay(at: Date = new Date()): number {
  const [h, m] = jakartaTimeString(at).split(":");
  return Number(h) * 60 + Number(m);
}

/** `ymd` shifted by `n` days, still as Y-m-d. */
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * True when a date is one we deliver on: a weekday `days` covers, and not a
 * libur nasional. `days` is a kitchen's `delivery_days`; omit it and the answer
 * is the business default, Senin–Sabtu. Minggu stopped being closed everywhere
 * when Santapin, which cooks Senin–Minggu, was onboarded.
 */
export function isDeliveryDay(ymd: string, days?: number[] | null): boolean {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  const iso = dow === 0 ? 7 : dow;
  const allowed = (days ?? BUSINESS_DAYS).filter((d) => d >= 1 && d <= 7);
  if (!(allowed.length === 0 ? BUSINESS_DAYS : allowed).includes(iso))
    return false;
  return !isClosedHoliday(ymd);
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
  /** The weekdays some kitchen works. Omitted, the business default applies. */
  days?: number[] | null;
}): { date: string; deadlinePassed: boolean } {
  const now = opts.now ?? new Date();
  const today = jakartaDateString(now);
  const deadlinePassed = jakartaHour(now) >= opts.deadlineHour;

  let date = addDays(today, deadlinePassed ? 2 : 1);
  // 60 is arbitrary but far past any real run of closures; it only exists so a
  // bad holiday table cannot spin here forever.
  for (let i = 0; i < 60 && !isDeliveryDay(date, opts.days); i++) {
    date = addDays(date, 1);
  }
  return { date, deadlinePassed };
}

/**
 * The next `days` dates, each already labelled with its weekday and whether we
 * can still promise it. Handed to the model so a relative day word is a lookup
 * rather than a calculation.
 *
 * The prompt used to state today's date and the cutoff hour and tell the model
 * to "compute the actual calendar date yourself". It computed badly. On
 * 2026-08-31 at 21:54 WIB — five hours past the cutoff — Cindi asked what time
 * tomorrow's delivery came and got "untuk besok (Selasa, 2 September)": the
 * right date, carrying the wrong weekday and the wrong relative word, for a
 * day the kitchen was already closed for. Four minutes later she proposed
 * "besok, sabtu, minggu" to one address and was told "Bisa banget", Minggu
 * included, because weekday names were never resolved to dates and so never
 * met the closure list.
 *
 * Every line is built from `isDeliveryDay`, the same function the sheet
 * generator asks, so the calendar and the food agree.
 */
export function deliveryCalendar(opts: {
  deadlineHour: number;
  now?: Date;
  days?: number;
  /**
   * The weekdays some active kitchen works — the union, not one kitchen's list,
   * because the calendar is written before the customer has chosen a dapur.
   */
  servedDays?: number[] | null;
  /**
   * Of those, the ones only some kitchens work. They are deliverable, but not
   * from every dapur, and the line says so: promising Minggu to a customer on a
   * Senin–Jumat kitchen is the same false promise as promising a closed day.
   */
  partialDays?: number[] | null;
}): string {
  const now = opts.now ?? new Date();
  const today = jakartaDateString(now);
  const deadlinePassed = jakartaHour(now) >= opts.deadlineHour;
  const lines: string[] = [];

  for (let i = 0; i < (opts.days ?? 14); i++) {
    const date = addDays(today, i);
    const label = formatHolidayDate(date);
    if (i === 0) {
      lines.push(`- ${label} — HARI INI, sudah lewat untuk pengiriman`);
      continue;
    }
    if (!isDeliveryDay(date, opts.servedDays)) {
      lines.push(
        `- ${label} — TUTUP, tidak ada pengiriman${date === addDays(today, 1) ? ' (ini yang customer sebut "besok")' : ""}`,
      );
      continue;
    }
    if (i === 1 && deadlinePassed) {
      lines.push(
        `- ${label} — SUDAH DIKUNCI, deadline ${opts.deadlineHour}.00 WIB hari ini sudah lewat. Ini yang customer sebut "besok", dan jawabannya tidak bisa.`,
      );
      continue;
    }
    const isoDow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    const partial = (opts.partialDays ?? []).includes(isoDow);
    lines.push(
      `- ${label} — bisa dikirim${partial ? ", TAPI hanya sebagian dapur — cek dapur customer dulu sebelum menjanjikan tanggal ini" : ""}${date === addDays(today, 1) ? ' (ini yang customer sebut "besok")' : ""}`,
    );
  }
  return lines.join("\n");
}
