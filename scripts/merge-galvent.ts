/**
 * galvent changed WhatsApp number on 2026-08-19 ("No wa lama gk pakai lg y").
 * phone_number is the only unique key, so he arrived as a stranger and got a
 * second customer row holding his new thread and his new order, while his June
 * and July history stayed on the old one. Merge the old row into the new.
 *
 *   tsx scripts/merge-galvent.ts [--apply]
 */
import { createAdminClient } from "../src/lib/supabase/admin";

const SURVIVOR = "caba2964-7a34-4047-95e0-9a4bb2f0aa87"; // +6281775043598, the live number
const LOSER = "4ff5f8ad-c59b-4542-845f-dcf9affa51e5"; // +6281168851005, the old number
const APPLY = process.argv.includes("--apply");

const MOVABLE = [
  { table: "orders", column: "customer_id" },
  { table: "conversations", column: "customer_id" },
  { table: "daily_deliveries", column: "customer_id" },
  { table: "broadcast_recipients", column: "customer_id" },
  { table: "delivery_proofs", column: "matched_customer_id" },
] as const;

const SINGLETON = ["customer_flags", "customer_state", "customer_rate_limits"] as const;

async function main() {
  const db = createAdminClient();
  for (const { table, column } of MOVABLE) {
    const { data: rows, error } = await db.from(table).select("id").eq(column, LOSER);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!rows?.length) continue;
    console.log(`${table}.${column}: ${rows.length}`);
    if (APPLY) {
      const { error: upErr } = await db
        .from(table)
        .update({ [column]: SURVIVOR })
        .eq(column, LOSER);
      if (upErr) throw new Error(`${table} update: ${upErr.message}`);
    }
  }
  for (const table of SINGLETON) {
    const { data: loserRow } = await db.from(table).select("customer_id").eq("customer_id", LOSER).maybeSingle();
    if (!loserRow) continue;
    const { data: survivorRow } = await db.from(table).select("customer_id").eq("customer_id", SURVIVOR).maybeSingle();
    console.log(`${table}: ${survivorRow ? "drop loser row" : "move to survivor"}`);
    if (APPLY) {
      if (survivorRow) await db.from(table).delete().eq("customer_id", LOSER);
      else await db.from(table).update({ customer_id: SURVIVOR }).eq("customer_id", LOSER);
    }
  }
  if (APPLY) {
    const { error } = await db.from("customers").delete().eq("id", LOSER);
    if (error) throw new Error(`delete customer: ${error.message}`);
    console.log("old row deleted");
  } else {
    console.log("dry run — pass --apply");
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
