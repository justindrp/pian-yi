import type { SupabaseClient } from "@supabase/supabase-js";
import { jakartaDateString } from "@/lib/menu/week";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/**
 * The two numbers people mean by "sisa kuota", and the dates behind them.
 *
 * `remainingToday` — bought but not yet delivered. What a customer is asking
 * for when they ask how much they have left.
 * `unbooked` — bought and not yet on the calendar. How many more dates they can
 * still ask for.
 *
 * Nadya's were 12 and 0 on 2026-08-20: twelve meals still coming, every one of
 * them already dated. `orders.portions_remaining` cached the second number and
 * was read as the first, which is how a fully-paid customer gets told her
 * package is finished. Both are counted from the rows now; the column is gone.
 */
export type CustomerSchedule = {
  upcoming: { date: string; mealType: string; portions: number }[];
  remainingToday: number;
  unbooked: number;
};

// Statuses whose package_size the customer has actually paid for. A
// pending_payment order is not quota yet, and the cancelled ones never were.
const PAID_STATUSES = ["active", "paused", "completed"];

/** Null when the customer has never bought a package. */
export async function loadCustomerSchedule(
  db: Db,
  customerId: string,
  today: string = jakartaDateString(),
): Promise<CustomerSchedule | null> {
  const [{ data: orders }, { data: rows }] = await Promise.all([
    db
      .from("orders")
      .select("package_size")
      .eq("customer_id", customerId)
      .in("status", PAID_STATUSES),
    db
      .from("daily_deliveries")
      .select("delivery_date, meal_type, portions")
      .eq("customer_id", customerId)
      .order("delivery_date"),
  ]);

  if (!orders?.length) return null;

  const bought = orders.reduce((s, o) => s + (o.package_size ?? 0), 0);
  // Counted customer-wide rather than per order, deliberately: which order a
  // delivery was charged to is unreliable (see pick-draw-order.ts), and the
  // customer only ever asks about their own total.
  const all = rows ?? [];
  const drawnToDate = all
    .filter((r) => (r.delivery_date ?? "") <= today)
    .reduce((s, r) => s + (r.portions ?? 0), 0);
  const drawnAll = all.reduce((s, r) => s + (r.portions ?? 0), 0);

  return {
    remainingToday: bought - drawnToDate,
    unbooked: bought - drawnAll,
    upcoming: all
      .filter((r) => (r.delivery_date ?? "") >= today)
      .slice(0, 12)
      .map((r) => ({
        date: (r.delivery_date ?? "").slice(0, 10),
        mealType: r.meal_type ?? "lunch",
        portions: r.portions ?? 0,
      })),
  };
}

/**
 * Portions of one order bought but not yet delivered, as of `today`.
 *
 * This is the number an order is finished on, and it is not the same as
 * `unbookedByOrder` below: this one stops at today, that one counts the whole
 * calendar. The retired `orders.portions_remaining` column blurred the two —
 * it was decremented when a row was booked, so it reached 0 when the calendar
 * filled rather than when the food had gone out. Four orders were completed on
 * it while still owing 35 portions between them, Nadya's on 2026-08-13 with
 * twelve meals to come, which left her with no active order at all and the bot
 * with no quota context for her.
 */
export async function orderRemainingToday(
  db: Db,
  orderId: string,
  packageSize: number,
  today: string = jakartaDateString(),
): Promise<number> {
  const { data: rows } = await db
    .from("daily_deliveries")
    .select("portions")
    .eq("order_id", orderId)
    .lte("delivery_date", today);

  const drawn = (rows ?? []).reduce((s, r) => s + (r.portions ?? 0), 0);
  return packageSize - drawn;
}

/**
 * Portions each order has bought but not yet had delivered, keyed by order id —
 * the batch form of `orderRemainingToday`. This is "sisa makanan", the number a
 * customer means by sisa kuota, and it is not `unbookedByOrder` below: a
 * customer whose whole package is already dated has 0 unbooked and a full
 * balance still to eat.
 *
 * Batched because the renewal cron asks it of every active order at once, and
 * one round trip per order was 300 of them.
 */
export async function remainingTodayByOrder(
  db: Db,
  orders: { id: string; package_size: number | null }[],
  today: string = jakartaDateString(),
): Promise<Map<string, number>> {
  return sumRowsByOrder(db, orders, today);
}

/**
 * Portions each order has bought but not yet put on the calendar, keyed by
 * order id. The guard the sheet generators use before writing another row.
 *
 * Every row on the order counts, because every row on the order is a delivery
 * that will happen — a skipped one was deleted, not marked. This used to carve
 * out 'cancelled' and 'skipped' statuses; the column that held them is gone.
 *
 * The generators had no balance check at all, which is why reactivating a
 * wrongly-completed order was unsafe: `status = 'active'` plus a standing
 * `meal_time_preference` was the whole test, so every future Generate wrote
 * another row past the package. On 2026-08-20, 21 of the 28 rows the generator
 * built for the next day were already over-draws.
 */
export async function unbookedByOrder(
  db: Db,
  orders: { id: string; package_size: number | null }[],
): Promise<Map<string, number>> {
  return sumRowsByOrder(db, orders, null);
}

/**
 * package_size minus the order's delivery rows — up to `upTo` when given, and
 * across the whole calendar when null.
 *
 * Paginated with fetchAllRows: a fixed window would silently stop subtracting
 * once the table outgrew it, and every order past the cut would read as having
 * more balance than it has.
 */
async function sumRowsByOrder(
  db: Db,
  orders: { id: string; package_size: number | null }[],
  upTo: string | null,
): Promise<Map<string, number>> {
  const left = new Map<string, number>(
    orders.map((o) => [o.id, o.package_size ?? 0]),
  );
  if (orders.length === 0) return left;

  const { rows } = await fetchAllRows<{
    order_id: string | null;
    portions: number | null;
  }>((from, to) => {
    const q = db
      .from("daily_deliveries")
      .select("order_id, portions")
      .in(
        "order_id",
        orders.map((o) => o.id),
      );
    return (upTo ? q.lte("delivery_date", upTo) : q).range(from, to);
  });

  for (const row of rows) {
    if (!row.order_id) continue;
    const rest = left.get(row.order_id);
    if (rest === undefined) continue;
    left.set(row.order_id, rest - (row.portions ?? 0));
  }
  return left;
}
