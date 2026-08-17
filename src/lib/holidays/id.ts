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

const DAY_NAMES = [
  "Minggu",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
];
const MONTH_NAMES = [
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
 */
export function describeUpcomingHolidays(
  today: string = jakartaDateString(),
  days = 45,
): string | null {
  if (today > HOLIDAYS_KNOWN_THROUGH) return null;
  const upcoming = upcomingHolidays(today, days);
  if (upcoming.length === 0) return null;

  return upcoming
    .map(
      (h) =>
        `- ${formatHolidayDate(h.date)} — ${h.name}${h.type === "cuti_bersama" ? " (cuti bersama)" : ""}: ${
          h.type === "libur_nasional"
            ? "TUTUP, tidak ada pengiriman"
            : "belum tentu tutup — tergantung dapur partner, harus dicek dulu"
        }`,
    )
    .join("\n");
}
