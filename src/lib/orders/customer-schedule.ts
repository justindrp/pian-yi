import type { SupabaseClient } from "@supabase/supabase-js";
import { jakartaDateString } from "@/lib/menu/week";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/**
 * The two numbers people mean by "sisa kuota", and the dates behind them.
 *
 * `remainingToday` — bought but not yet delivered. What a customer is asking
 * for when they ask how much they have left.
 * `unbooked` — bought and not yet on the calendar. How many more dates they can
 * still ask for, and what `orders.portions_remaining` stores.
 *
 * Nadya's were 12 and 0 on 2026-08-20: twelve meals still coming, every one of
 * them already dated. Reading the stored counter as the first number says she
 * has nothing left, which is how a fully-paid customer gets told her package is
 * finished.
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
      .select("delivery_date, meal_type, portions, status")
      .eq("customer_id", customerId)
      .neq("status", "cancelled")
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
