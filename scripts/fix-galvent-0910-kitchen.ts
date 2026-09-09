/**
 * galvent's 2026-09-10 dinner row was written by `record_daily_order` on
 * 2026-09-08 and landed on Perut Bahagia, a kitchen he has not been on since
 * June. He is a Thenie customer (`customers.subcontractor_id`), and Thenie is
 * where the 10-porsi package he is eating was bought.
 *
 * Cause: `recordDailyOrder()` took the cooking kitchen from the order it drew
 * against instead of from the customer, and it drew against the oldest active
 * order with quota regardless of kitchen — a June Perut Bahagia order. Fixed in
 * `src/lib/orders/record-daily-order.ts`; this repairs the one row that path
 * already wrote.
 *
 * The row is repointed to the Thenie package (8 porsi still undated) as well as
 * re-kitchened, because charging a Thenie dinner to a Perut Bahagia package
 * spends the wrong ladder's money.
 */
import { createClient } from "@supabase/supabase-js";
import { logEdit, systemActor } from "../src/lib/audit/log-edit";

const ROW_ID = "5ac6456b-ff16-4ac3-97d5-db623233cd92";
const THENIE = "52cd5e62-da09-49c9-939c-2f1246566c40";
const THENIE_ORDER = "ce3f8431-24fa-48cb-8645-01dcadc5926e";

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  );

  const { data: before, error: readErr } = await db
    .from("daily_deliveries")
    .select("*")
    .eq("id", ROW_ID)
    .single();
  if (readErr || !before) throw new Error(readErr?.message ?? "row not found");

  console.log("before:", JSON.stringify(before));

  const { error } = await db
    .from("daily_deliveries")
    .update({ subcontractor_id: THENIE, order_id: THENIE_ORDER })
    .eq("id", ROW_ID);
  if (error) throw new Error(error.message);

  await logEdit({
    db,
    actor: systemActor("fix-galvent-0910-kitchen"),
    entityType: "daily_delivery",
    entityId: ROW_ID,
    action: "reroute_kitchen",
    changes: {
      from: {
        subcontractor_id: before.subcontractor_id,
        order_id: before.order_id,
      },
      to: { subcontractor_id: THENIE, order_id: THENIE_ORDER },
      reason:
        "record_daily_order took the kitchen from a June Perut Bahagia order; customer is on Thenie",
    },
  });

  const { data: after } = await db
    .from("daily_deliveries")
    .select("*")
    .eq("id", ROW_ID)
    .single();
  console.log("after:", JSON.stringify(after));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
