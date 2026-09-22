import { getSetting } from "@/lib/cache/settings";

/**
 * Portion sizes, and what each one costs us at the kitchen.
 *
 * Size lives on the order (`orders.size`), never on the delivery row — a
 * delivery has an `order_id`, so its size is derived, not duplicated. Which
 * kitchens cook M is per kitchen (`subcontractors.offers_size_m`), the same way
 * delivery areas are: right now only Thenie does, and nothing may hardcode
 * that, because it stops being true the moment a second kitchen adds the dish.
 */

/** The two portion sizes. `orders.size` has held these since migration 043. */
export type OrderSize = "s" | "m";

/** Anything that is not the literal "m" is an S order. */
export function normalizeSize(size: string | null | undefined): OrderSize {
  return String(size ?? "")
    .trim()
    .toLowerCase() === "m"
    ? "m"
    : "s";
}

/** The four COGS columns a kitchen bills us on, as `subcontractors` holds them. */
export type KitchenRates = {
  cost_per_portion: number | null;
  cost_per_portion_route1: number | null;
  cost_per_portion_m?: number | null;
  cost_per_portion_route1_m?: number | null;
};

/**
 * What one portion costs us from this kitchen.
 *
 * Route 1 is our own courier, so a kitchen charges less for it; a null override
 * means it bills one rate for both routes. M has the same pair again, and each
 * M column falls back to the *M* rate before the S one — a kitchen that set a
 * single M price bills that price on both routes, and reading its S route-1
 * rate there would undercharge every M portion we deliver ourselves.
 */
export function kitchenCostPerPortion(
  sub: KitchenRates,
  size: OrderSize,
  route: 1 | 2,
): number {
  const base = sub.cost_per_portion ?? 0;
  const route1 = sub.cost_per_portion_route1 ?? base;
  if (size === "s") return route === 1 ? route1 : base;
  const baseM = sub.cost_per_portion_m ?? base;
  const route1M =
    sub.cost_per_portion_route1_m ?? sub.cost_per_portion_m ?? route1;
  return route === 1 ? route1M : baseM;
}

/** The one column a kitchen states its own M tambahan in. */
export type KitchenMSurcharge = { size_m_surcharge?: number | null };

/**
 * What size M costs the customer per portion on top of the S price.
 *
 * A setting, not a constant, because it is a price — and it stacks on a
 * contract rate the same way the nasi merah add-on does, because M is a real
 * extra dish (item 4 on the weekly menu) that the kitchen bills us for either
 * way. Reads 0 if the row is missing or unparseable, which prices an M order as
 * S: too cheap by 4.000/porsi is a margin problem an admin can fix, where a NaN
 * would write `total_price: null` on a real order.
 *
 * **Per kitchen, the same way the ladder is** (migration 131). The global
 * setting is Rp 4.000 because that is *Thenie's* figure — their M costs us
 * Rp 3.000 more, marked up at Justin's 20% — and it stopped being the whole
 * answer the moment a second kitchen cooked M: Molls bill Rp 5.000 more, which
 * is Rp 6.500 marked up. One figure across every kitchen would have quoted
 * Molls' M Rp 2.500 a portion light, the same shape of loss `tiersForKitchen()`
 * exists to stop. `subcontractors.size_m_surcharge` NULL means this kitchen has
 * never been priced separately and the house figure stands, exactly like
 * `cost_per_portion_route1`; a stored 0 is a kitchen that really does throw the
 * extra dish in, so it is honoured rather than treated as unset.
 */
export async function sizeMSurcharge(
  sub?: KitchenMSurcharge | null,
): Promise<number> {
  const own = sub?.size_m_surcharge;
  if (typeof own === "number" && Number.isFinite(own) && own >= 0) return own;
  const raw = await getSetting("size_m_surcharge");
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
