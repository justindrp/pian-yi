// Which week a menu image covers.
//
// `subcontractors.menu_image_url` used to carry no indication of which week its
// image was for, so both the system prompt and the send_menu_image tool
// description simply asserted the stored image was always the CURRENT week.
// That is true Monday–Thursday and false the moment next week's menu goes up:
// the menu is published every Friday for the following week, so from Friday
// afternoon until Sunday night the stored image is *next* week's.
//
// Vania asked for next week's menu on Saturday 2026-08-15, when Batch 50
// (17–22 Agustus) — exactly what she wanted — was already uploaded. The bot
// refused and told her to come back on Friday, because the prompt said what it
// held could only be the current week. An admin had to send it by hand.

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000; // WIB, UTC+7 — no DST

/** Y-m-d in Jakarta time, which is the timezone the business operates in. */
export function jakartaDateString(at: Date = new Date()): string {
  return new Date(at.getTime() + JAKARTA_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Monday of the week containing `ymd` (weeks run Senin–Minggu). */
export function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * Default week for a menu uploaded on `ymd`, as a Monday date.
 *
 * A default only — never trust it as the answer. Publication is nominally
 * Friday, but Batch 50 (17–22 Agustus) went up on Thursday 2026-08-13, so the
 * upload day does not reliably identify the week. That is exactly why the value
 * is stored and editable on the subcontractor form rather than derived at read
 * time: whoever uploads the image is the only one who actually knows.
 *
 * Thursday onward defaults to next week, since by then the current week is
 * nearly over and a new image is far more likely to be the upcoming batch.
 */
export function defaultMenuWeekStart(ymd: string): string {
  const monday = mondayOf(ymd);
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  const publishedForNextWeek = dow >= 4 || dow === 0;
  if (!publishedForNextWeek) return monday;

  const next = new Date(`${monday}T00:00:00Z`);
  // Sunday already belongs to the week that started the previous Monday, so its
  // "next week" is one Monday on — same as Friday's and Saturday's.
  next.setUTCDate(next.getUTCDate() + 7);
  return next.toISOString().slice(0, 10);
}

const MONTHS_ID = [
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

/**
 * The week a menu covers, spelled out as the span customers see: "Senin 17 –
 * Sabtu 22 Agustus 2026". Delivery runs Senin–Sabtu, so the week ends Saturday.
 *
 * The prompt used to pass the bare Monday, and the bot read it back as the only
 * date it had: asked on 2026-08-16 how far the menu went, it answered "Baru
 * sampai minggu depan (Senin, 17 Agustus)", which reads as coverage ending on
 * the 17th rather than starting there.
 */
export function formatMenuWeekRange(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 5);
  const startMonth = MONTHS_ID[start.getUTCMonth()];
  const endMonth = MONTHS_ID[end.getUTCMonth()];
  const head =
    startMonth === endMonth
      ? `Senin ${start.getUTCDate()}`
      : `Senin ${start.getUTCDate()} ${startMonth}`;
  return `${head} – Sabtu ${end.getUTCDate()} ${endMonth} ${end.getUTCFullYear()}`;
}

/**
 * How the menu on file relates to today: the week it covers, in words the model
 * can act on without having to do date arithmetic itself.
 */
export function describeMenuWeek(
  menuWeekStart: string | null,
  today: string = jakartaDateString(),
): MenuWeek {
  if (!menuWeekStart) return { relation: "unknown", weekStart: null };

  const thisMonday = mondayOf(today);
  if (menuWeekStart === thisMonday)
    return { relation: "current", weekStart: menuWeekStart };
  return menuWeekStart > thisMonday
    ? { relation: "next", weekStart: menuWeekStart }
    : { relation: "past", weekStart: menuWeekStart };
}

export type MenuWeek = {
  relation: "current" | "next" | "past" | "unknown";
  weekStart: string | null;
};

/**
 * The week covered by the images send_menu_image would actually send.
 *
 * That tool sends every active kitchen's image, so the prompt can only make a
 * claim about the week if the kitchens agree on it. They disagree today only in
 * the sense that one is active — but a second kitchen coming back mid-week with
 * an older batch must not let the bot promise next week's menu, so a mismatch
 * (or any missing value) falls back to "unknown", which tells the model to send
 * the image without naming a week.
 */
export function describeMenuWeeks(
  menuWeekStarts: (string | null)[],
  today: string = jakartaDateString(),
): MenuWeek {
  const distinct = new Set(menuWeekStarts);
  if (distinct.size !== 1) return { relation: "unknown", weekStart: null };
  return describeMenuWeek([...distinct][0], today);
}
