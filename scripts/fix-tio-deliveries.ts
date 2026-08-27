/**
 * One-off: writes the Senin–Jumat lunch run Tio Jason confirmed on 2026-08-18
 * (bot acknowledged it and booked nothing — record_daily_order was never called).
 * 25 Agustus is Maulid Nabi, so that day is skipped.
 */
import { createAdminClient } from "../src/lib/supabase/admin";

const CUSTOMER = "7c39b235-ecf1-46f8-aa07-6784d9684762";
const ORDER_PREFIX = "3b89069e";
const DATES = [
  "2026-08-19",
  "2026-08-20",
  "2026-08-21",
  "2026-08-24",
  "2026-08-26",
  "2026-08-27",
  "2026-08-28",
];
const APPLY = process.argv.includes("--apply");

async function main() {
  const db = createAdminClient();

  const { data: orders } = await db
    .from("orders")
    .select(
      "id, status, package_size, subcontractor_id, meal_time_preference",
    )
    .eq("customer_id", CUSTOMER)
    .eq("status", "active");
  const order = (orders ?? []).find((o) => o.id.startsWith(ORDER_PREFIX));
  if (!order) throw new Error("active order 3b89069e not found");

  const { data: cust } = await db
    .from("customers")
    .select("name, portions_remaining, subcontractor_id")
    .eq("id", CUSTOMER)
    .single();

  const { data: existing } = await db
    .from("daily_deliveries")
    .select("delivery_date")
    .eq("customer_id", CUSTOMER)
    .in("delivery_date", DATES);
  const taken = new Set((existing ?? []).map((r) => r.delivery_date));
  const fresh = DATES.filter((d) => !taken.has(d));

  const kitchen = order.subcontractor_id ?? cust?.subcontractor_id ?? null;

  // The balance is package_size minus the rows that exist. The counter this
  // used to read (orders.portions_remaining) is gone — migration 074.
  const { data: booked } = await db
    .from("daily_deliveries")
    .select("portions")
    .eq("order_id", order.id);
  const rem =
    (order.package_size ?? 0) -
    (booked ?? []).reduce((n, r) => n + (r.portions ?? 0), 0);

  console.log(
    "order",
    order.id,
    "rem",
    rem,
    "kitchen",
    kitchen,
  );
  console.log("already booked:", [...taken].join(", ") || "none");
  console.log("to write:", fresh.join(", "));
  console.log("rem after:", rem - fresh.length);

  if (!APPLY) return console.log("\ndry run — pass --apply");
  if (fresh.length > rem)
    throw new Error("would overdraft");

  const { error } = await db.from("daily_deliveries").insert(
    fresh.map((delivery_date) => ({
      order_id: order.id,
      customer_id: CUSTOMER,
      delivery_date,
      meal_type: "lunch",
      portions: 1,
      subcontractor_id: kitchen,
      notes: "Dijadwalkan manual — bot gagal mencatat 18 Agustus 2026",
    })),
  );
  if (error) throw new Error(error.message);

  await db
    .from("customers")
    .update({
      portions_remaining: Math.max(
        0,
        (cust?.portions_remaining ?? 0) - fresh.length,
      ),
    })
    .eq("id", CUSTOMER);

  console.log(`\nwrote ${fresh.length} rows`);
}
main();
