/**
 * Two goodwill portions for Sherine Fayola, for the foreign object she found in
 * the gorengan, delivered as one extra day after her package runs out.
 *
 * She reported it on 4 September 2026 with a video of that day's lunch, a photo
 * of an earlier occurrence ("ini yg sblmnya"), and a third photo that evening
 * ("ini yg br datang jg masih ada"). Her own count was "udah 2x begitu", and
 * that is the count we compensate — the third rests on the evening photo alone.
 *
 * She never asked for money. She asked four times across four days to be put
 * through to a person and was never answered; the bot apologised and
 * re-escalated five times instead. The kitchen cannot substitute her fried
 * dishes and has not accepted a chargeback, so the portions come out of our own
 * margin.
 *
 * A grant is its own Rp 0 `free_quota` order, never a bump to `package_size` —
 * the ledger has to show it as a discrete +2 line (the Fahmi correction on
 * 2026-08-25 exists because an inline bump did not).
 *
 * Her paid package ends 17 September, lunch and dinner every delivery day, so
 * the two portions become 18 September lunch + dinner — the next day she would
 * otherwise have nothing. 18 September is a Friday, a Thenie delivery day, and
 * not a libur nasional. The rows are charged to the grant order rather than
 * allocated, because that is the whole point of the +2 line.
 *
 *   set -a && . ./.env.local && set +a && pnpm tsx scripts/fix-sherine-goodwill.ts [--apply]
 */
import { createAdminClient } from "../src/lib/supabase/admin";

const CUSTOMER_ID = "de16913f-6fae-4c92-a6b8-cbb168833597";
const KITCHEN_ID = "52cd5e62-da09-49c9-939c-2f1246566c40";
const PORTIONS = 2;
const GRANT_DATE = "2026-09-08";
const DELIVERY_DATE = "2026-09-18";
const REASON =
  "Kompensasi benda asing di menu gorengan, 2 laporan (4 September 2026)";
const GRANTED_BY = "drpramadyo@gmail.com";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { data: cust, error: custErr } = await db
    .from("customers")
    .select("id, name, portions_remaining")
    .eq("id", CUSTOMER_ID)
    .single();
  if (custErr || !cust) throw new Error(`Customer not found: ${custErr?.message}`);

  const { data: clash } = await db
    .from("daily_deliveries")
    .select("id, meal_type")
    .eq("customer_id", CUSTOMER_ID)
    .eq("delivery_date", DELIVERY_DATE);
  if ((clash ?? []).length > 0) {
    throw new Error(
      `${DELIVERY_DATE} already has ${clash?.length} row(s) for this customer`,
    );
  }

  console.log(`Customer: ${cust.name}`);
  console.log(`  portions_remaining now: ${cust.portions_remaining}`);
  console.log(`  grant: +${PORTIONS} porsi, ${GRANT_DATE}`);
  console.log(`  reason: ${REASON}`);
  console.log(`  rows: ${DELIVERY_DATE} lunch x1, ${DELIVERY_DATE} dinner x1`);

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    return;
  }

  const { data: inserted, error: insErr } = await db
    .from("orders")
    .insert({
      customer_id: CUSTOMER_ID,
      status: "active",
      price_per_portion: 0,
      total_price: 0,
      package_size: PORTIONS,
      portions_per_delivery: PORTIONS,
      start_date: GRANT_DATE,
      subcontractor_id: KITCHEN_ID,
      source: "free_quota",
      grant_reason: REASON,
      granted_by: GRANTED_BY,
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`Insert failed: ${insErr.message}`);

  const { error: rowsErr } = await db.from("daily_deliveries").insert(
    ["lunch", "dinner"].map((meal) => ({
      delivery_date: DELIVERY_DATE,
      customer_id: CUSTOMER_ID,
      order_id: inserted.id,
      meal_type: meal,
      portions: 1,
      subcontractor_id: KITCHEN_ID,
      address_slot: 1,
    })),
  );
  if (rowsErr) throw new Error(`Delivery rows failed: ${rowsErr.message}`);

  await db
    .from("customers")
    .update({
      portions_remaining: (cust.portions_remaining ?? 0) + PORTIONS,
    })
    .eq("id", CUSTOMER_ID);

  await db.from("edit_log").insert({
    entity_type: "orders",
    entity_id: inserted.id,
    action: "create",
    changed_by: GRANTED_BY,
    changes: {
      portions: PORTIONS,
      reason: REASON,
      date: GRANT_DATE,
      delivery_date: DELIVERY_DATE,
    },
  });

  console.log(`\nApplied. free_quota order ${inserted.id} + 2 rows on ${DELIVERY_DATE}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
