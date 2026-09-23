import type { SupabaseClient } from "@supabase/supabase-js";
import { sizeMSurcharge } from "@/lib/orders/size";
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
 * would look wrong. Migration 098 keyed the table by `subcontractor_id`.
 *
 * There is no house ladder (migration 135). The rows 098 kept as one were
 * Thenie's prices under a null kitchen, and they now carry her id. A kitchen
 * with no rows, or no kitchen at all, gets an empty ladder — never someone
 * else's prices. `getExtractedOrderPricing()` refuses an empty one rather
 * than price at Rp 0, and an active kitchen cannot have one (the trigger in
 * migration 135).
 *
 * Every read of the table goes through here. A bare select returns every
 * kitchen's rows interleaved, and the largest-tier-below lookup on top of that
 * quotes whichever kitchen happens to sort first — a wrong price that looks
 * like it worked.
 */
export async function tiersForKitchen(
  db: Db,
  subcontractorId: string | null,
): Promise<PriceTier[]> {
  if (!subcontractorId) return [];
  const { data } = await db
    .from("pricing_tiers")
    .select("portions, price_per_portion")
    .eq("subcontractor_id", subcontractorId)
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
 * list the bot quotes from is one block per active kitchen, and building it a
 * query at a time runs on every inbound message. A kitchen with no rows maps to
 * an empty ladder, exactly as the single-kitchen read does.
 */
export async function laddersForKitchens(
  db: Db,
  subcontractorIds: readonly string[],
): Promise<Map<string, PriceTier[]>> {
  const byKitchen = new Map<string, PriceTier[]>();
  if (subcontractorIds.length === 0) return byKitchen;

  const { data: own } = await db
    .from("pricing_tiers")
    .select("subcontractor_id, portions, price_per_portion")
    .in("subcontractor_id", [...subcontractorIds])
    .order("portions", { ascending: true });

  for (const id of subcontractorIds) {
    byKitchen.set(
      id,
      (own ?? [])
        .filter((t) => t.subcontractor_id === id)
        .map((t) => ({
          portions: t.portions,
          price_per_portion: t.price_per_portion,
        })),
    );
  }
  return byKitchen;
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

/**
 * What one kitchen takes off a portion sold without rice.
 *
 * `subcontractors.no_rice_discount` (migration 098) sat unread for six weeks
 * while the prompt told the bot the price was identical for every kitchen —
 * true of Thenie alone, and wrong by Rp 4.000 a portion at Dapur Monstera.
 * Migration 116 settles what NULL means: nothing to take off, never a reason
 * to refuse the request.
 *
 * Returns 0 for a kitchen we cannot name. Nothing is priced without a kitchen
 * any more (migration 135), so the answer is never used.
 */
export async function noRiceDiscount(
  db: Db,
  subcontractorId: string | null,
): Promise<number> {
  if (!subcontractorId) return 0;
  const { data } = await db
    .from("subcontractors")
    .select("no_rice_discount")
    .eq("id", subcontractorId)
    .maybeSingle();
  const off = data?.no_rice_discount ?? 0;
  return typeof off === "number" && off > 0 ? off : 0;
}

/**
 * What one kitchen adds for a size M portion.
 *
 * The same shape as `noRiceDiscount()` above and for the same reason: a single
 * global figure is one kitchen's number wearing everyone's name. A kitchen we
 * cannot name falls back to `settings.size_m_surcharge`; nothing is priced
 * without a kitchen any more (migration 135), so that is a last resort only.
 */
export async function kitchenMSurcharge(
  db: Db,
  subcontractorId: string | null,
): Promise<number> {
  if (!subcontractorId) return sizeMSurcharge();
  const { data } = await db
    .from("subcontractors")
    .select("size_m_surcharge")
    .eq("id", subcontractorId)
    .maybeSingle();
  return sizeMSurcharge(data);
}
