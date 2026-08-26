import { createClient } from "@supabase/supabase-js";
import { logEdit } from "../src/lib/audit/log-edit";
import { requiredEnv } from "../src/lib/env";

const ID = "3c7383cb-7c12-440e-9637-f1cf844a6479";
const JUNE = "476440a1-e148-4686-9f57-4ea59bd82a05"; // active, holds her carried-over quota
const OLD10 = "7c0fc797-93f5-487c-aea4-0720a3614fde"; // the -2 the phantom rows caused
const THENIE = "52cd5e62-da09-49c9-939c-2f1246566c40";
const APPLY = process.argv.includes("--apply");

// She asked for Senin-Sabtu. Monday was refused on a passed cutoff and Tuesday
// on a holiday Thenie does not take, so both are added back. They draw from the
// June order, which is the oldest active one with quota left — pickDrawOrder's
// own rule.
const ADD = [
  { delivery_date: "2026-08-24", meal_type: "dinner" },
  { delivery_date: "2026-08-25", meal_type: "dinner" },
];

async function main() {
  const db = createClient(
    requiredEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    ),
    requiredEnv(
      "SUPABASE_SERVICE_ROLE_KEY",
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    ),
  );

  const rows = ADD.map((a) => ({
    ...a,
    customer_id: ID,
    order_id: JUNE,
    subcontractor_id: THENIE,
    portions: 1,
    address_slot: 1,
    status: "scheduled",
  }));
  console.log("rows to insert:");
  for (const r of rows) console.log(" ", JSON.stringify(r));
  console.log(
    `orders.portions_remaining: ${OLD10.slice(0, 8)} -2 -> 0 (phantom rows returned), ${JUNE.slice(0, 8)} 4 -> 2 (two days booked)`,
  );

  if (!APPLY) {
    console.log("\nDRY RUN — rerun with --apply");
    return;
  }

  const { error: insErr } = await db
    .from("daily_deliveries")
    .upsert(rows, { onConflict: "delivery_date,customer_id,meal_type" });
  if (insErr) throw insErr;

  const a = await db
    .from("orders")
    .update({ portions_remaining: 0 })
    .eq("id", OLD10);
  if (a.error) throw a.error;
  const b = await db
    .from("orders")
    .update({ portions_remaining: 2 })
    .eq("id", JUNE);
  if (b.error) throw b.error;

  await logEdit({
    db,
    actor: "justindrp2@gmail.com",
    entityType: "daily_deliveries",
    entityId: ID,
    action: "restore_refused_days",
    changes: {
      reason:
        "bot refused Senin 24 (cutoff passed by 2 min) and skipped Selasa 25 (global holiday table; Thenie is open). Customer asked for Senin-Sabtu.",
      added: rows,
      portions_remaining: { [OLD10]: "-2 -> 0", [JUNE]: "4 -> 2" },
    },
  });
  console.log("inserted + counters updated + edit_log written.");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
