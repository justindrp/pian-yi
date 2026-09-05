import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/** ISO weekday number to the Indonesian name a customer reads. */
const WEEKDAY = [
  "",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
  "Minggu",
];

/**
 * "Senin–Sabtu", "Senin–Jumat", "Senin, Rabu, Jumat" — the days a kitchen
 * cooks, written the way it goes to a customer.
 *
 * `subcontractors.delivery_days` (migration 098) is ISO weekday numbers because
 * Senin–Sabtu stopped being a fact about the business the moment a kitchen that
 * does not work Saturdays was added: Homey's September grid has five columns.
 * A contiguous run collapses to a dash, anything else is listed.
 */
export function daysLabel(days: number[] | null | undefined): string {
  const sorted = [...new Set(days ?? [])]
    .filter((d) => d >= 1 && d <= 7)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  if (sorted.length === 1) return WEEKDAY[sorted[0]];
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  return contiguous
    ? `${WEEKDAY[sorted[0]]}–${WEEKDAY[sorted[sorted.length - 1]]}`
    : sorted.map((d) => WEEKDAY[d]).join(", ");
}

/**
 * Whether a kitchen cooks on a given date.
 *
 * `isDeliveryDay()` answers for the business — Minggu and libur nasional — and
 * that used to be the whole answer, because every kitchen worked Senin–Sabtu.
 * It is not any more: Homey cooks Senin–Jumat, so a Sabtu row assigned to it is
 * food nobody makes, and nothing downstream would say so. Both questions have
 * to be asked; this one is the kitchen's half.
 *
 * An empty or missing list means the kitchen has not said, and the business
 * calendar is then the only constraint — never a silent refusal of every day.
 */
export function kitchenDeliversOn(
  days: number[] | null | undefined,
  ymd: string,
): boolean {
  const allowed = (days ?? []).filter((d) => d >= 1 && d <= 7);
  if (allowed.length === 0) return true;
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return allowed.includes(dow === 0 ? 7 : dow);
}

/**
 * The weekdays Pian Yi cooks on right now: the union of `delivery_days` across
 * every subcontractor with `is_active = true`, as ISO weekday numbers.
 *
 * Which days are worked belongs to the kitchen, the same way coverage does.
 * Santapin cooks seven days, Homey five, Thenie six, so "Senin–Sabtu, Minggu
 * tutup" is not a fact anyone may write down — a page that states it refuses
 * food a kitchen has already agreed to cook. A kitchen with an empty list has
 * not said, and counts as Senin–Sabtu rather than as no days at all.
 *
 * Never cache the result across a request.
 */
export async function activeDeliveryDays(
  db: SupabaseClient<Database>,
): Promise<number[]> {
  const { data, error } = await db
    .from("subcontractors")
    .select("delivery_days")
    .eq("is_active", true);

  if (error) throw new Error(`activeDeliveryDays: ${error.message}`);

  const lists = (data ?? []).map((s) =>
    Array.isArray(s.delivery_days) && s.delivery_days.length > 0
      ? s.delivery_days
      : [1, 2, 3, 4, 5, 6],
  );
  return [...new Set(lists.flat())]
    .filter((d) => d >= 1 && d <= 7)
    .sort((a, b) => a - b);
}
