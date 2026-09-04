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

/**
 * What size M costs the customer per portion on top of the S price.
 *
 * A setting, not a constant, because it is a price — and it stacks on a
 * contract rate the same way the nasi merah add-on does, because M is a real
 * extra dish (item 4 on the weekly menu) that the kitchen bills us for either
 * way. Reads 0 if the row is missing or unparseable, which prices an M order as
 * S: too cheap by 4.000/porsi is a margin problem an admin can fix, where a NaN
 * would write `total_price: null` on a real order.
 */
export async function sizeMSurcharge(): Promise<number> {
  const raw = await getSetting("size_m_surcharge");
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
