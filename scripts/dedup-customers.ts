/**
 * Merges duplicate customers created when the import ran with a real phone
 * against an existing IMPORT_<slug> placeholder from a prior import run.
 *
 * Strategy:
 *  1. Find all customers whose phone starts with "IMPORT_"
 *  2. For each, find another customer with the same normalized name
 *  3. Reassign any orders from the old placeholder → new real-phone record
 *  4. Delete the old placeholder record
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function normalize(name: string) {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Load all customers
  const { data: all, error } = await db
    .from("customers")
    .select("id, name, phone_number, area, created_at");
  if (error || !all) { console.error(error); process.exit(1); }

  const placeholders = all.filter(c => c.phone_number?.startsWith("IMPORT_"));
  console.log(`Found ${placeholders.length} placeholder records`);

  let merged = 0, skipped = 0;

  for (const old of placeholders) {
    const oldNorm = normalize(old.name ?? "");
    // Find a real-phone customer with the same name (excluding self)
    const match = all.find(
      c => c.id !== old.id && !c.phone_number?.startsWith("IMPORT_") && normalize(c.name ?? "") === oldNorm
    );

    if (!match) {
      console.log(`  SKIP (no match): ${old.name} [${old.phone_number}]`);
      skipped++;
      continue;
    }

    console.log(`  MERGE: "${old.name}" ${old.phone_number} → ${match.phone_number} (${match.id})`);

    // Reassign orders from old → new
    const { data: movedOrders, error: ordErr } = await db
      .from("orders")
      .update({ customer_id: match.id })
      .eq("customer_id", old.id)
      .select("id");
    if (ordErr) { console.error(`    ERROR reassigning orders:`, ordErr.message); continue; }
    if (movedOrders?.length) console.log(`    Moved ${movedOrders.length} order(s)`);

    // Delete placeholder's daily_deliveries — real-phone customer already has their own rows
    const { error: ddErr } = await db.from("daily_deliveries").delete().eq("customer_id", old.id);
    if (ddErr) { console.error(`    ERROR deleting daily_deliveries:`, ddErr.message); continue; }

    // Delete conversation state, rate limits, processed messages for old record
    await db.from("conversation_state").delete().eq("customer_id", old.id);
    await db.from("customer_rate_limits").delete().eq("customer_id", old.id);

    // Delete the old placeholder customer
    const { error: delErr } = await db.from("customers").delete().eq("id", old.id);
    if (delErr) { console.error(`    ERROR deleting old record:`, delErr.message); continue; }

    merged++;
  }

  console.log(`\nDone: ${merged} merged, ${skipped} skipped (no real-phone match found)`);
}
main();
