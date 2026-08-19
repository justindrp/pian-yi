import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Whether an order already carries a delivery schedule.
 *
 * Both mark_paid paths generated the standing Senin–Sabtu pattern the moment
 * payment landed, without asking. An order created from an explicit
 * delivery_schedule already has the days the customer asked for, and those days
 * are usually a subset: Tiwi's 6-porsi order was written for 19, 20, 21, 24, 26
 * and 27 Agustus, deliberately skipping Sabtu 22 and Maulid Nabi on the 25th.
 * The upsert's ignoreDuplicates only stops an exact collision, so the two days
 * her schedule skipped were inserted on top — 8 draws against a 6-porsi package.
 *
 * A schedule that exists is the customer's; regenerating can only overwrite it
 * with the default pattern.
 */
export async function orderHasDeliveries(orderId: string): Promise<boolean> {
  const db = createAdminClient();
  const { count } = await db
    .from("daily_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("order_id", orderId);
  return (count ?? 0) > 0;
}
