import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

export type PriceTier = { portions: number; price_per_portion: number };

/**
 * The price ladder a kitchen sells on.
 *
 * `pricing_tiers` was one ladder for the whole business, which was true while
 * one kitchen cooked everything. Thenie costs us Rp 21.000 a portion, Santapin
 * Rp 22.000 and Homey Rp 33.000 — quoting Homey's food at Thenie's Rp 28.000
 * tier is a Rp 5.000 loss per portion, every portion, and nothing in the order
 * would look wrong. Migration 098 keys the table by `subcontractor_id` and
 * keeps the existing rows as the house ladder: `subcontractor_id IS NULL` is
 * what a kitchen with no rows of its own is sold at, and it is exactly Thenie's
 * ladder, so Thenie needs no rows.
 *
 * Every read of the table goes through here. A bare select now returns every
 * kitchen's rows interleaved, and the largest-tier-below lookup on top of that
 * quotes whichever kitchen happens to sort first — a wrong price that looks
 * like it worked.
 */
export async function tiersForKitchen(
  db: Db,
  subcontractorId: string | null,
): Promise<PriceTier[]> {
  if (subcontractorId) {
    const { data } = await db
      .from("pricing_tiers")
      .select("portions, price_per_portion")
      .eq("subcontractor_id", subcontractorId)
      .order("portions", { ascending: true });
    if (data && data.length > 0) return data;
  }

  const { data } = await db
    .from("pricing_tiers")
    .select("portions, price_per_portion")
    .is("subcontractor_id", null)
    .order("portions", { ascending: true });
  return data ?? [];
}

/**
 * The per-portion rate for a total, off one kitchen's ladder: the largest
 * listed size at or below the total.
 *
 * A total below the smallest tier matches no row and used to price at Rp 0 —
 * Dewi's 2026-08-03 order was written that way (package 3, price 0), food the
 * kitchen cooked for free. Fall back to the cheapest tier we publish; a price
 * an admin adjusts beats a price of nothing. Null only when the ladder is empty.
 */
export function priceForPortions(
  tiers: PriceTier[],
  portions: number,
): number | null {
  let best: PriceTier | null = null;
  for (const tier of tiers) {
    if (tier.portions <= portions && (!best || tier.portions > best.portions))
      best = tier;
  }
  const fallback = tiers.reduce<PriceTier | null>(
    (min, t) => (!min || t.portions < min.portions ? t : min),
    null,
  );
  return (best ?? fallback)?.price_per_portion ?? null;
}
