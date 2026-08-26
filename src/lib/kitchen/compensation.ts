// The kitchen note carries what the *customer* asked for, never what we do
// about it internally.
//
// "Tanpa nasi" bumps the protein portion by 25%. That compensation is our
// arrangement with the kitchen — an operational and commercial term — and it
// reaches them through their rate and their brief, not through a customer's
// record. Writing it on the delivery sheet states an internal term as if the
// customer had asked for it, on a page that is unauthenticated and shared with
// the subcontractor. The sheet already refuses to print prices for the same
// reason (see MONEY in `src/app/dapur/[id]/page.tsx`).
//
// The model puts it there unprompted, because the sentence it is told to say to
// the customer contains it: `learnCustomerContext` wrote "tanpa nasi (protein
// +25%)" into Surya's context twice on 2026-08-25.
//
// Stripped, not dropped: the compensation is usually a parenthetical hanging off
// the request itself, so removing the whole clause would take "tanpa nasi" with
// it — the one thing the kitchen actually needs.
//
// The wording varies per summary — "protein +25%", "protein ditambah 25%",
// "protein porsi ditambah 25% sebagai pengganti" all appear in live notes — so
// the parts are assembled rather than written out three times.
const PROTEIN = String.raw`(?:porsi\s+)?(?:protein|lauk)(?:\s*nya)?(?:\s+porsi)?`;
const TAIL = String.raw`(?:\s*(?:lebih\s+banyak|sebagai\s+(?:gantinya|penggantinya|pengganti)|sbg\s+gantinya))?`;
const COMPENSATION = new RegExp(
  [
    String.raw`\(\s*(?:dengan\s+)?${PROTEIN}[^)]*?\d{1,3}\s*%[^)]*\)`,
    String.raw`,?\s*(?:dengan\s+|dan\s+)?${PROTEIN}\s*(?:di)?(?:tambah|naik|plus)?\s*\+?\s*\d{1,3}\s*%${TAIL}`,
    String.raw`,?\s*\+\s*\d{1,3}\s*%\s*(?:porsi\s+)?(?:protein|lauk)`,
  ].join("|"),
  "gi",
);

/**
 * Remove any protein-compensation clause from a kitchen-facing note, keeping
 * the customer's actual request. Used both when writing the note
 * (`mergeKitchenNote`) and when rendering it, so customers whose context was
 * summarised before this existed are covered too.
 */
export function stripCompensation(text: string): string {
  return text
    .replace(COMPENSATION, "")
    .replace(/\s*\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,;.])/g, "$1")
    .replace(/[,;]\s*$/, "")
    .replace(/^[\s,;]+/, "")
    .trim();
}
