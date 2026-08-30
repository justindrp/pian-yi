// What a clause is asking of the courier rather than of the cook. The note is
// one field and the two audiences are different people: Julian S's card read
// "Preferensi: Makanan diantar ke atas (lantai atas) tidak ada kacang dan
// bawang goreng titip dibagian drop off info aja kepetugasnya kalo makanan ini
// diantar keatas" — one green box in which the only thing the kitchen has to
// act on, no peanuts and no fried shallots, is the middle third of a paragraph
// about stairs. Split, so each half is read by whoever it is for.
//
// A clause is a delivery instruction if it names the handover: where it goes,
// who takes it, what to do on arrival. Everything else is food, because that is
// the safer default — a dietary request shown to a courier is noise, and a
// dietary request the cook never sees is the wrong meal.
const DELIVERY_CLAUSE =
  /\b(antar|anter|diantar|dianter|diantarkan|kirim|dikirim|lantai|lobby|lobi|drop\s*off|dropoff|security|satpam|resepsionis|receptionist|titip|gerbang|portal|petugas|kurir|driver|ojek|telepon|telfon|telp|hubungi|pintu|unit|tower|parkir|depan|ke\s+atas|keatas|jam\s+\d)/i;

/** Clauses as an admin or the model wrote them, one per line and per separator. */
function splitClauses(text: string): string[] {
  return text
    .split(/[\n;,]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/**
 * The note as the two boxes on the kitchen card: what to cook, and what to do
 * with it once it is cooked.
 *
 * Takes the preference string the page has already assembled and filtered, so
 * nothing is dropped here that would otherwise have printed — the same string
 * is partitioned, never filtered. A clause that fits neither reading still
 * prints, under `food`.
 */
export function splitPreferences(preference: string | null): {
  food: string | null;
  delivery: string | null;
} {
  if (!preference) return { food: null, delivery: null };
  const clauses = splitClauses(preference);
  const delivery = clauses.filter((c) => DELIVERY_CLAUSE.test(c));
  const food = clauses.filter((c) => !DELIVERY_CLAUSE.test(c));
  return {
    food: food.join(", ") || null,
    delivery: delivery.join(", ") || null,
  };
}
