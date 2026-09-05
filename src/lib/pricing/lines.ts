import type { PriceTier } from "@/lib/pricing/tiers";

/**
 * The price list the bot quotes from, rendered out of one kitchen's ladder.
 *
 * These twelve lines were a hardcoded const in `system.ts`, correct for exactly
 * one ladder. `pricing_tiers` is keyed by kitchen (migration 098) and the
 * kitchens do not cost the same — Homey's food quoted off Thenie's ladder is a
 * Rp 12.000 loss per portion — so the block has to be drawn from whichever
 * ladder the customer is actually buying on.
 *
 * The ladder is stored as portions, and a customer counts days: a tier of 5 is
 * "5 hari siang/malam saja", and the 10-portion tier above it is the same five
 * days with both meals. The table is built in groups of four for that reason —
 * [5, 6, 10, 12], [20, 24, 40, 48], [60, 72, 120, 144] — each group a pair of
 * day counts and their doubles. A ladder that is not a multiple of four is not
 * that shape, so it is listed plainly by portions rather than guessed at.
 */
export function priceListLines(tiers: PriceTier[]): string {
  const sorted = [...tiers].sort((a, b) => a.portions - b.portions);
  const plain = () =>
    sorted
      .map(
        (t) =>
          `- ${t.portions} porsi: Rp ${(t.portions * t.price_per_portion).toLocaleString("id-ID")} (Rp ${t.price_per_portion.toLocaleString("id-ID")}/porsi)`,
      )
      .join("\n");
  if (sorted.length === 0 || sorted.length % 4 !== 0) return plain();

  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i += 4) {
    const [a, b, aa, bb] = sorted.slice(i, i + 4);
    if (aa.portions !== a.portions * 2 || bb.portions !== b.portions * 2)
      return plain();
    for (const [single, double] of [
      [a, aa],
      [b, bb],
    ] as const) {
      const days = single.portions;
      lines.push(
        `- ${days} hari siang/malam saja: Rp ${(single.portions * single.price_per_portion).toLocaleString("id-ID")} (Rp ${single.price_per_portion.toLocaleString("id-ID")}/meal)`,
      );
      lines.push(
        `- ${days} hari siang + malam: Rp ${(double.portions * double.price_per_portion).toLocaleString("id-ID")} (Rp ${double.price_per_portion.toLocaleString("id-ID")}/meal)`,
      );
    }
  }
  return lines.join("\n");
}
