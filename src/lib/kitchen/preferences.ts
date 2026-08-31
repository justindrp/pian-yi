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

// A phone number has no reader on the kitchen card. The page is unauthenticated
// and shared with the subcontractor, the card deliberately carries no customer
// number, and the one that showed up was somebody else's: Cila's note named the
// WhatsApp of the person who buys for her. Redacted rather than dropped, so a
// clause that also carries a dietary request keeps the request.
const PHONE = /(?:\+?62|\b0)\d[\d\s().-]{7,}\d/g;

// Who bought the package, whose number it was arranged on, what the system does
// and does not hold — all true, and none of the kitchen's business. Same rule as
// "no protein +25% in a kitchen note": the sheet carries what the customer asked
// for, never our internal answer to it.
const INTERNAL_NOTE =
  /\b(dikoordinasi\w*|dibeli\s+(?:lewat|oleh|via|melalui)|belum\s+punya\s+nomor|nomor\s+sendiri|di\s+sistem|didaftarkan|atas\s+nama\s+pembeli)\b/i;

/**
 * A hand-typed note is not automatically safe to print. It reaches the kitchen
 * on the same unauthenticated page as everything else here, and the two things
 * that must never land there — a phone number, and how the order was arranged
 * internally — are exactly what an admin writes down for their own colleagues.
 * Everything else a human typed still prints verbatim: the AI block's other
 * filters are not applied here, because an admin who wrote "langganan lama,
 * porsi besar" meant both halves.
 */
export function safeManualNote(manual: string): string | null {
  const clauses = manual
    .split(/[\n;,]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const kept = clauses
    .map((clause) => clause.replace(PHONE, "").replace(/\s{2,}/g, " ").trim())
    .filter((clause) => clause && !INTERNAL_NOTE.test(clause));
  // Nothing was removed: hand back what the admin typed, newlines and
  // semicolons and all. Re-joining an untouched note only mangles its layout.
  if (kept.length === clauses.length && kept.every((clause, i) => clause === clauses[i])) {
    return manual;
  }
  return kept.join(", ").trim() || null;
}
