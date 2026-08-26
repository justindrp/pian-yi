/**
 * Cancels the phantom orders the 2026-08-19 recovery regression created, and
 * restores the customer name one of them overwrote. Each id was verified by
 * hand against the thread: the customer never asked for that package.
 */
import { createAdminClient } from "../src/lib/supabase/admin";

const PHANTOMS = [
  "b59aaf77-67f8-4651-b9d2-61a55ca3943f", // galvent 5 — real order is ce3f8431 (10)
  "54581b2f-5599-446e-9976-ebc1c30cdc7c", // galvent 5 — off "Bsk 2 porsi y kk"
  "464b4309-6ceb-4ee2-91aa-c3ec1e46849b", // Nicholas Satria 10 — off a menu question
  "0598f908-5169-4e75-a40e-6ad2077a5c76", // Julian S 5 — off a reschedule request
  "39130d6a-f603-4ffd-97c9-a0a766a42eb5", // Sherine 5 — off a question about swapping days
  "2c6ae55c-ea39-4771-8cda-0a26066c6fe5", // Sherine 20 — superseded by 89c21740 (40)
];

async function main() {
  const db = createAdminClient();
  for (const id of PHANTOMS) {
    const { data: order } = await db
      .from("orders")
      .select("id, customer_id, package_size, status")
      .eq("id", id)
      .maybeSingle();
    if (!order) {
      console.log(`${id.slice(0, 8)} not found`);
      continue;
    }
    const { data: dels } = await db
      .from("daily_deliveries")
      .select("id")
      .eq("order_id", id);
    await db.from("daily_deliveries").delete().eq("order_id", id);
    await db
      .from("orders")
      .update({ status: "cancelled_by_admin", portions_remaining: 0 })
      .eq("id", id);
    // Order creation credits the customer counter; take the phantom back off it.
    const { data: cust } = await db
      .from("customers")
      .select("portions_remaining")
      .eq("id", order.customer_id ?? "")
      .maybeSingle();
    await db
      .from("customers")
      .update({
        portions_remaining: Math.max(
          0,
          (cust?.portions_remaining ?? 0) - order.package_size,
        ),
      })
      .eq("id", order.customer_id ?? "");
    console.log(
      `${id.slice(0, 8)} cancelled (pkg ${order.package_size}, ${dels?.length ?? 0} deliveries removed)`,
    );
  }

  // "Julian S" was renamed to "Julian" by the phantom order's extraction.
  const { error } = await db
    .from("customers")
    .update({ name: "Julian S" })
    .eq("id", "4acddf61-76f8-43b4-a20d-e836b49d3c4a");
  console.log(
    error ? `name restore failed: ${error.message}` : "name restored: Julian S",
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
