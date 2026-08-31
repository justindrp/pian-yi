import { DAY_NAMES, MONTH_NAMES } from "@/lib/holidays/id";

// The model writes the weekday of a date it did not work out.
//
// On 2026-08-31 Cindi was told her package started "Selasa, 2 September 2026"
// in three separate replies. 2 September is a Rabu. The date was right — it
// came from her order — and the weekday was invented next to it, so the two
// halves of the same phrase disagreed and the customer had no way to know
// which one to believe. Worse, at 21:54 WIB, hours after the cutoff, the same
// sentence opened with "untuk besok": the model took the soonest deliverable
// date the prompt had handed it and relabelled it with the customer's own
// word. She was left expecting food the next day for an order that had not
// even been paid.
//
// A weekday against a date is arithmetic, so it is checked here rather than
// asked for again in the prompt. The fix is silent: the date is the half that
// came from us, so the weekday is the half that gets corrected.

const MONTH_INDEX = new Map(
  MONTH_NAMES.map((m, i) => [m.toLowerCase(), i] as const),
);

const WEEKDAY_DATE = new RegExp(
  `\\b(${DAY_NAMES.join("|")})(,?\\s+)(\\d{1,2})(\\s+)(${MONTH_NAMES.join("|")})(\\s+(\\d{4}))?`,
  "gi",
);

/**
 * The year the customer must mean. An explicit one wins; otherwise pick
 * whichever of last year, this year and next year lands nearest `refYmd`, so a
 * "2 Januari" said in December resolves forward rather than eleven months back.
 */
function resolveYear(refYmd: string, month: number, day: number): number {
  const ref = Date.parse(`${refYmd}T00:00:00Z`);
  const refYear = Number(refYmd.slice(0, 4));
  let best = refYear;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const year of [refYear - 1, refYear, refYear + 1]) {
    const gap = Math.abs(Date.UTC(year, month, day) - ref);
    if (gap < bestGap) {
      bestGap = gap;
      best = year;
    }
  }
  return best;
}

/**
 * Correct any weekday name the reply pairs with a date it does not fall on.
 * `refYmd` is today in Jakarta, used only to pick the year when the reply
 * leaves it out. Text with no such pair comes back untouched.
 */
export function fixWeekdayNames(text: string, refYmd: string): string {
  return text.replace(
    WEEKDAY_DATE,
    (whole, weekday, gap1, dayRaw, gap2, monthRaw, yearPart, yearRaw) => {
      const month = MONTH_INDEX.get(String(monthRaw).toLowerCase());
      if (month === undefined) return whole;
      const day = Number(dayRaw);
      const year = yearRaw
        ? Number(yearRaw)
        : resolveYear(refYmd, month, day);
      const d = new Date(Date.UTC(year, month, day));
      // 31 September and friends roll over into the next month. A date that
      // does not exist is not one to attach a weekday to, so leave it alone
      // and let the reply say what the model wrote.
      if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return whole;
      const correct = DAY_NAMES[d.getUTCDay()];
      if (correct.toLowerCase() === String(weekday).toLowerCase()) return whole;
      console.warn(
        `[fix-dates] weekday corrected: "${weekday} ${day} ${monthRaw}" -> "${correct}"`,
      );
      return `${correct}${gap1}${dayRaw}${gap2}${monthRaw}${yearPart ?? ""}`;
    },
  );
}
