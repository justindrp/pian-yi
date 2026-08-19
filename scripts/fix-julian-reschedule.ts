/**
 * Julian S asked on 2026-08-19 to skip Thursday 20 and Friday 21 August. The
 * bot answered with a phantom order instead, so the reschedule was never made.
 * Drop the Friday row and push the portion to the next open delivery day —
 * 25 August is Maulid Nabi, so it lands on Wednesday 26.
 */
import { createAdminClient } from "../src/lib/supabase/admin";

const ORDER = "eb3179b7";

async function main() {
  const db = createAdminClient();
  const customerId = "4acddf61-76f8-43b4-a20d-e836b49d3c4a";
  const { data: order } = await db
    .from("orders")
    .select("id, subcontractor_id")
    .eq("customer_id", customerId)
    .eq("status", "active")
    .maybeSingle();
  if (!order?.id.startsWith(ORDER)) throw new Error("active order is not eb3179b7");

  const { data: template } = await db
    .from("daily_deliveries")
    .select("*")
    .eq("order_id", order.id)
    .eq("delivery_date", "2026-08-21")
    .maybeSingle();
  if (!template) {
    console.log("21 Aug row already gone");
    return;
  }
  await db.from("daily_deliveries").delete().eq("id", template.id);
  const { id: _id, created_at: _c, updated_at: _u, ...rest } = template as Record<string, unknown> & { id: string };
  const { error } = await db
    .from("daily_deliveries")
    .insert({
      ...rest,
      delivery_date: "2026-08-26",
      status: "scheduled",
    } as never);
  console.log(error ? `insert failed: ${error.message}` : "21 Aug skipped, portion moved to 26 Aug");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
