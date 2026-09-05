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
