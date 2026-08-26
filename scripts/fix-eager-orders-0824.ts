/**
 * One-off, 2026-08-24. Two orders `createOrderFromExtraction` wrote before the
 * conversation had settled, both with `start_date` defaulted to the earliest
 * deliverable date instead of what the customer said:
 *
 *  - `ab7d586d` (+6285716119878) — 48 porsi, Rp 1.248.000, created at 01:26Z,
 *    one minute BEFORE the bot told the customer we do not deliver to Cipondoh.
 *    Nobody agreed to buy it. Cancel it and take its 24 rows off the calendar.
 *  - `67aeb972` (Naya) — a real order she asked for, but she said "mulai tgl 31
 *    Agust" and the bot confirmed it back to her twice. Move `start_date` to
 *    2026-08-31 and rebuild the rows from the same generator the cron uses.
 *
 * Without this, tomorrow's kitchen sheet cooks 5 portions nobody ordered:
 * `cancel-unpaid` only becomes eligible after the sheet is worked, and it never
 * touches `daily_deliveries` anyway.
 *
 * Dry run by default. Pass --apply to write. Rows are dumped to a rollback JSON
 * before anything is deleted.
 */
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { logEdit } from "../src/lib/audit/log-edit";
import { buildRecurringDeliveryRows } from "../src/lib/orders/build-recurring-deliveries";

const APPLY = process.argv.includes("--apply");
const ACTOR = "drpramadyo@gmail.com";
const OUT = process.env.ROLLBACK_OUT ?? "./rollback-eager-orders-0824.json";

const CANCEL_ID = "ab7d586d-8696-4235-b46b-8df892b6ea49";
const NAYA_ID = "67aeb972-dd10-4981-ac6f-4fbc1cca472e";
const NAYA_START = "2026-08-31";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key)
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required",
  );

const db = createClient(url, key);

/** Only the columns this script prints. */
type Slot = { delivery_date: string; meal_type: string; portions: number };

function summarise(rows: Slot[]): string {
  return rows
    .map((r) => `${r.delivery_date.slice(5)} ${r.meal_type}x${r.portions}`)
    .join(" | ");
}

async function orderById(id: string) {
  const { data, error } = await db
    .from("orders")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

async function rowsFor(orderId: string) {
  const { data, error } = await db
    .from("daily_deliveries")
    .select("*")
    .eq("order_id", orderId)
    .order("delivery_date");
  if (error) throw error;
  return data ?? [];
}

async function main() {
  const cancel = await orderById(CANCEL_ID);
  const naya = await orderById(NAYA_ID);
  const cancelRows = await rowsFor(cancel.id);
  const nayaRows = await rowsFor(naya.id);

  const rebuilt = buildRecurringDeliveryRows({
    customer_id: naya.customer_id,
    end_date: naya.end_date,
    lunch_address_slot: naya.lunch_address_slot,
    dinner_address_slot: naya.dinner_address_slot,
    meal_time_preference: naya.meal_time_preference,
    order_id: naya.id,
    package_size: naya.package_size,
    portions_dinner: naya.portions_dinner,
    portions_lunch: naya.portions_lunch,
    portions_per_delivery: naya.portions_per_delivery,
    start_date: NAYA_START,
    subcontractor_id: naya.subcontractor_id,
  });

  console.log(`CANCEL ${cancel.id} — ${cancelRows.length} rows to delete`);
  console.log(`  ${summarise(cancelRows)}`);
  console.log(
    `NAYA  ${naya.id} — start_date ${naya.start_date} -> ${NAYA_START}`,
  );
  console.log(`  delete ${nayaRows.length}: ${summarise(nayaRows)}`);
  console.log(`  insert ${rebuilt.length}: ${summarise(rebuilt)}`);

  if (rebuilt.length !== nayaRows.length) {
    console.warn(
      `  WARN row count changed ${nayaRows.length} -> ${rebuilt.length}`,
    );
  }

  if (!APPLY) {
    console.log("\nDRY RUN — pass --apply to write.");
    return;
  }

  writeFileSync(
    OUT,
    JSON.stringify({ cancel, cancelRows, naya, nayaRows }, null, 2),
  );
  console.log(`\nrollback written to ${OUT}`);

  // 1. Out-of-area order: rows off the calendar, then the order itself.
  const { error: e1 } = await db
    .from("daily_deliveries")
    .delete()
    .eq("order_id", cancel.id);
  if (e1) throw e1;
  const { error: e2 } = await db
    .from("orders")
    .update({
      status: "cancelled_by_admin",
      cancelled_at: new Date().toISOString(),
      cancellation_reason:
        "Di luar area pengiriman (Cipondoh) — order dibuat otomatis sebelum area dicek, pelanggan tidak pernah memesan",
    })
    .eq("id", cancel.id);
  if (e2) throw e2;
  await logEdit({
    db: db as never,
    actor: ACTOR,
    entityType: "order",
    entityId: cancel.id,
    action: "cancel",
    changes: {
      reason: "out of delivery area, order created before the area check",
      status: { from: cancel.status, to: "cancelled_by_admin" },
      deliveries_deleted: cancelRows.length,
    },
  });
  console.log(`cancelled ${cancel.id}, deleted ${cancelRows.length} rows`);

  // 2. Naya: same package, correct week.
  const { error: e3 } = await db
    .from("daily_deliveries")
    .delete()
    .eq("order_id", naya.id);
  if (e3) throw e3;
  const { error: e4 } = await db
    .from("orders")
    .update({ start_date: NAYA_START })
    .eq("id", naya.id);
  if (e4) throw e4;
  const { error: e5 } = await db.from("daily_deliveries").insert(rebuilt);
  if (e5) throw e5;
  await logEdit({
    db: db as never,
    actor: ACTOR,
    entityType: "order",
    entityId: naya.id,
    action: "edit",
    changes: {
      reason:
        'customer said "mulai tgl 31 Agust"; order defaulted to the earliest deliverable date',
      start_date: { from: naya.start_date, to: NAYA_START },
      deliveries_rebuilt: { from: nayaRows.length, to: rebuilt.length },
    },
  });
  console.log(
    `moved ${naya.id} to ${NAYA_START}, rebuilt ${rebuilt.length} rows`,
  );
}

main().catch((e) => {
  console.error(JSON.stringify(e, null, 2));
  process.exit(1);
});
