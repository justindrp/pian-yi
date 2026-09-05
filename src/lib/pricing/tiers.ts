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

/**
 * Every kitchen's ladder in one read, keyed by kitchen id.
 *
 * `tiersForKitchen()` is one query per kitchen, which is right when an order is
 * being priced and wrong when the prompt has to publish all of them: the price
 * list the bot quotes from is now one block per active kitchen, and building it
 * a query at a time runs on every inbound message.
 *
 * A kitchen with no rows of its own maps to the house ladder, exactly as the
 * single-kitchen read does. The house ladder comes back beside them because a
 * prompt built for a customer with no kitchen resolved still has to publish a
 * price list, and it is the one we would sell them at.
 */
export async function laddersForKitchens(
  db: Db,
  subcontractorIds: readonly string[],
): Promise<{ house: PriceTier[]; byKitchen: Map<string, PriceTier[]> }> {
  const { data: house } = await db
    .from("pricing_tiers")
    .select("portions, price_per_portion")
    .is("subcontractor_id", null)
    .order("portions", { ascending: true });

  const byKitchen = new Map<string, PriceTier[]>();
  if (subcontractorIds.length === 0) return { house: house ?? [], byKitchen };

  const { data: own } = await db
    .from("pricing_tiers")
    .select("subcontractor_id, portions, price_per_portion")
    .in("subcontractor_id", [...subcontractorIds])
    .order("portions", { ascending: true });

  for (const id of subcontractorIds) {
    const mine = (own ?? [])
      .filter((t) => t.subcontractor_id === id)
      .map((t) => ({
        portions: t.portions,
        price_per_portion: t.price_per_portion,
      }));
    byKitchen.set(id, mine.length > 0 ? mine : (house ?? []));
  }
  return { house: house ?? [], byKitchen };
}

/** Two ladders quote the same price for every size the other lists. */
export function sameLadder(a: PriceTier[], b: PriceTier[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (t, i) =>
      t.portions === b[i].portions &&
      t.price_per_portion === b[i].price_per_portion,
  );
}
