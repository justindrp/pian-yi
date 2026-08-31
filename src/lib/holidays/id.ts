import { jakartaDateString } from "@/lib/menu/week";

/**
 * Indonesian public holidays, so the bot never has to recall one mid-sentence.
 *
 * Asked "besok bisa kirim ga kak?" on 2026-08-16 the bot answered "Bisa kak,
 * besok kami tetap kirim", then caught itself two sentences later — "17 Agustus
 * itu Hari Kemerdekaan RI" — and reversed to closed. The final answer was right
 * and the customer received all three stages of it. The prompt said we close on
 * tanggal merah without ever saying which days those are, so the model had to
 * remember, and remembering happened after it had already committed.
 *
 * Most of these are not derivable from the date at all: Idulfitri, Iduladha,
 * Nyepi, Imlek and Waisak move with lunar calendars, the Easter-linked ones move
 * with Easter, and cuti bersama is set each year by ministerial decree. Recall is
 * the wrong mechanism even for a model that happens to know 17 Agustus.
 */

export type HolidayType = "libur_nasional" | "cuti_bersama";

export type Holiday = {
  /** ISO `YYYY-MM-DD`, Jakarta local. */
  date: string;
  name: string;
  type: HolidayType;
};

/**
 * SKB 3 Menteri for 2026, signed 2025-09-19: 17 libur nasional, 8 cuti bersama.
 * https://setneg.go.id/baca/index/inilah_skb_3_menteri_libur_nasional_dan_cuti_bersama_2026
 *
 * 2027 is not here because it does not exist yet — the decree is normally
 * published around September of the preceding year. `HOLIDAYS_KNOWN_THROUGH`
 * is what stops the bot from reading an empty list as "no holidays coming".
 */
export const HOLIDAYS: Holiday[] = [
  { date: "2026-01-01", name: "Tahun Baru Masehi", type: "libur_nasional" },
  {
    date: "2026-01-16",
    name: "Isra Mikraj Nabi Muhammad SAW",
    type: "libur_nasional",
  },
  { date: "2026-02-16", name: "Tahun Baru Imlek", type: "cuti_bersama" },
  { date: "2026-02-17", name: "Tahun Baru Imlek 2577", type: "libur_nasional" },
  { date: "2026-03-18", name: "Hari Suci Nyepi", type: "cuti_bersama" },
  {
    date: "2026-03-19",
    name: "Hari Suci Nyepi (Tahun Baru Saka 1948)",
    type: "libur_nasional",
  },
  { date: "2026-03-20", name: "Idulfitri 1447 H", type: "cuti_bersama" },
  { date: "2026-03-21", name: "Idulfitri 1447 H", type: "libur_nasional" },
  { date: "2026-03-22", name: "Idulfitri 1447 H", type: "libur_nasional" },
  { date: "2026-03-23", name: "Idulfitri 1447 H", type: "cuti_bersama" },
  { date: "2026-03-24", name: "Idulfitri 1447 H", type: "cuti_bersama" },
  { date: "2026-04-03", name: "Wafat Yesus Kristus", type: "libur_nasional" },
  {
    date: "2026-04-05",
    name: "Kebangkitan Yesus Kristus (Paskah)",
    type: "libur_nasional",
  },
  {
    date: "2026-05-01",
    name: "Hari Buruh Internasional",
    type: "libur_nasional",
  },
  {
    date: "2026-05-14",
    name: "Kenaikan Yesus Kristus",
    type: "libur_nasional",
  },
  { date: "2026-05-15", name: "Kenaikan Yesus Kristus", type: "cuti_bersama" },
  { date: "2026-05-27", name: "Iduladha 1447 H", type: "libur_nasional" },
  { date: "2026-05-28", name: "Iduladha 1447 H", type: "cuti_bersama" },
  {
    date: "2026-05-31",
    name: "Hari Raya Waisak 2570 BE",
    type: "libur_nasional",
  },
  { date: "2026-06-01", name: "Hari Lahir Pancasila", type: "libur_nasional" },
  {
    date: "2026-06-16",
    name: "1 Muharam Tahun Baru Islam 1448 H",
    type: "libur_nasional",
  },
  {
    date: "2026-08-17",
    name: "Proklamasi Kemerdekaan RI",
    type: "libur_nasional",
  },
  {
    date: "2026-08-25",
    name: "Maulid Nabi Muhammad SAW",
    type: "libur_nasional",
  },
  { date: "2026-12-24", name: "Kelahiran Yesus Kristus", type: "cuti_bersama" },
  {
    date: "2026-12-25",
    name: "Kelahiran Yesus Kristus",
    type: "libur_nasional",
  },
];

/** Last date the list actually covers. Past it, we know nothing — not "nothing". */
export const HOLIDAYS_KNOWN_THROUGH = "2026-12-31";

/**
 * The holiday falling on a date, if any. Delivery scheduling needs the type,
 * not just a yes/no: a libur nasional is closed, a cuti bersama is a question
 * for the partner kitchen.
 */
export function holidayOn(ymd: string): Holiday | null {
  return HOLIDAYS.find((h) => h.date === ymd) ?? null;
}

/**
 * Tanggal merah the kitchen works through anyway.
 *
 * Closure is a property of the kitchen, not of the calendar, and this table is
 * global. On 2026-08-23 Veronica Catherine asked to start Senin 24; the cutoff
 * had passed by two minutes, so `earliestDeliveryDate` moved to Selasa 25,
 * found Maulid Nabi here, and moved again to Rabu 26 — costing her a delivery
 * day that Thenie, the kitchen that actually serves her, was open for.
 *
 * A date belongs here when every active kitchen works it. That is a low bar
 * today because Thenie is the only kitchen taking standing orders, and a real
 * one again the moment a second kitchen does: revisit this before reactivating
 * one, because a wrong entry promises deliveries nobody will cook.
 */
const OPEN_DESPITE_HOLIDAY = new Set<string>(["2026-08-25"]);

/** True only for the days we are definitely closed. */
export function isClosedHoliday(ymd: string): boolean {
  if (OPEN_DESPITE_HOLIDAY.has(ymd)) return false;
  return holidayOn(ymd)?.type === "libur_nasional";
}

/**
 * True when we deliver on this date at all: Senin–Sabtu, minus the days we are
 * definitely closed.
 *
 * Saturday counts. It was excluded once, in the delivery generator this moved
 * out of, and no 6-day package could then produce its sixth day — every one
 * came up a delivery short with nothing saying so, and Julian S's 18–22
 * Agustus package generated four days for five portions. Minggu stays closed.
 *
 * Cuti bersama is deliberately not filtered: whether the partner kitchens work
 * those days is an escalation, not a closure.
 */
export function isDeliveryDay(ymd: string): boolean {
  const day = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  if (day < 1 || day > 6) return false;
  return !isClosedHoliday(ymd);
}

/** Holidays from `today` (inclusive) through the next `days` days. */
export function upcomingHolidays(
  today: string = jakartaDateString(),
  days = 45,
): Holiday[] {
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + days);
  const until = end.toISOString().slice(0, 10);
  return HOLIDAYS.filter((h) => h.date >= today && h.date <= until);
}

export const DAY_NAMES = [
  "Minggu",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
];
export const MONTH_NAMES = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/** "Senin 17 Agustus 2026" — the form the bot should say to a customer. */
export function formatHolidayDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The prompt block. Returns null when nothing is coming up, so the caller can
 * leave the section out entirely rather than print an empty heading.
 *
 * Every line asks `isClosedHoliday`, never `h.type`, so an entry in
 * `OPEN_DESPITE_HOLIDAY` reads as a working day here too. This block used to
 * print "TUTUP, tidak ada pengiriman" straight off the type: on 2026-08-24 at
 * 16:46 WIB Veronica Catherine asked to add lunch to her Selasa 25 delivery and
 * was told "kami tutup dan nggak ada pengiriman hari itu" — while her dinner row
 * for that date sat on Thenie's sheet, because generation had already been
 * taught the override. The customer would have received food she had just been
 * told was not coming. One rule, one source: the schedule and the sentence have
 * to be read off the same function.
 *
 * Every Minggu in the window is on the same list. It used to be a second rule
 * carried in the prompt instead — "any date not on this list is a working day
 * (except Minggu, which is always closed)" — which made the model work out the
 * day of week for every date itself. On 2026-08-29 Julie asked for 1–7
 * September; the model read that as seven delivery days and quoted 28 porsi at
 * Rp 728.000, when 6 September is a Minggu and the run is six days and 24
 * porsi. A closed date the model has to derive is a closed date it will
 * sometimes miss, so the list carries them and the prompt does no arithmetic.
 */
export function describeUpcomingHolidays(
  today: string = jakartaDateString(),
  days = 45,
): string | null {
  if (today > HOLIDAYS_KNOWN_THROUGH) return null;

  const entries = upcomingHolidays(today, days).map((h) => {
    const when = `- ${formatHolidayDate(h.date)} — ${h.name}${h.type === "cuti_bersama" ? " (cuti bersama)" : ""}`;
    if (h.type === "cuti_bersama")
      return {
        date: h.date,
        line: `${when}: belum tentu tutup — tergantung dapur partner, harus dicek dulu`,
      };
    if (!isClosedHoliday(h.date))
      return {
        date: h.date,
        line: `${when}: BUKA — tanggal merah, tapi kami tetap mengirim seperti biasa hari itu`,
      };
    return { date: h.date, line: `${when}: TUTUP, tidak ada pengiriman` };
  });

  // A Minggu that is also a tanggal merah is already named above; naming it
  // twice would let the model subtract it twice.
  for (const date of upcomingSundays(today, days)) {
    if (entries.some((e) => e.date === date)) continue;
    entries.push({
      date,
      line: `- ${formatHolidayDate(date)}: TUTUP, hari Minggu`,
    });
  }

  if (entries.length === 0) return null;
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries.map((e) => e.line).join("\n");
}

/** Every Minggu from `today` (inclusive) through the next `days` days. */
export function upcomingSundays(
  today: string = jakartaDateString(),
  days = 45,
): string[] {
  const out: string[] = [];
  const cursor = new Date(`${today}T00:00:00Z`);
  for (let i = 0; i <= days; i++) {
    if (cursor.getUTCDay() === 0) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
