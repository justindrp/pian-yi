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
