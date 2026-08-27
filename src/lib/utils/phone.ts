/**
 * Indonesian phone numbers, reduced to the one form the database stores.
 *
 * `customers.phone_number` is the record's identity — migration 065 put a
 * unique index on it — and every number we hold arrives as `+62…` because
 * that is the form WhatsApp hands us. A number a *customer* types is not in
 * that form: they write 0812…, 62812…, 812…, and they punctuate it. Comparing
 * those against the column finds nothing, so the same person gets a second
 * record and the uniqueness index never sees a conflict to reject.
 *
 * Returns null rather than a best guess when the input cannot be read as a
 * phone number. A caller that cannot identify someone must escalate; inventing
 * an identity here would attach an order to the wrong person.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  // Customers write 0812-3456-7890, (021) 555 0123, +62 812.3456.7890.
  const cleaned = trimmed.replace(/[\s\-.()]/g, "");
  if (!/^\+?\d+$/.test(cleaned)) return null;

  const digits = cleaned.replace(/^\+/, "");
  let national: string;
  if (digits.startsWith("62")) national = digits.slice(2);
  else if (digits.startsWith("0")) national = digits.slice(1);
  else if (cleaned.startsWith("+")) {
    // A foreign number, already in the only form we can trust for one: the
    // 0/62 shortcuts below assume Indonesia and would mangle it.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  } else national = digits;

  // Indonesian mobile numbers are 9–13 digits after the country code. Shorter
  // is a fragment the customer mistyped; longer is two numbers run together.
  if (national.length < 9 || national.length > 13) return null;
  if (!national.startsWith("8")) return null;

  return `+62${national}`;
}

/** Whether two numbers in any written form belong to the same person. */
export function samePhone(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  return left !== null && left === right;
}
