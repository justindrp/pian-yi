/**
 * The four delivery rows the wrong-year bug wrote, and the two dates Vania is
 * owed because of it.
 *
 * `record-daily-order.ts` compared each requested date against
 * `jakartaTimeString().slice(0, 10)` — which is "HH:MM", not a date — so every
 * well-formed date sorted below it and the past-date guard refused nothing. A
 * model that resolved "Selasa 8 September" to 2025 booked cleanly, and the row
 * it wrote can never reach a kitchen sheet, which keys on `delivery_date`. The
 * guard was fixed in d92225b on 2026-09-07 20:27 WIB; these rows predate it.
 *
 * A row is the whole truth about whether food is cooked, so deleting one is the
 * refund — nothing else is written and no counter is touched.
 *
 *   Vania  +6281292339008  2025-09-01 dinner x3  (written 2026-08-31 17:15 WIB)
 *   Vania  +6281292339008  2025-09-08 dinner x1  (written 2026-09-07 08:10 WIB,
 *                          the minute she asked for 8, 9 and 11 September)
 *   Febby  +628111818475   2024-09-05 lunch x1   (written 2026-09-02 14:42 WIB)
 *   Febby  +628111818475   2024-09-06 lunch x1   (written 2026-09-02 14:42 WIB)
 *
 * That returns 4 portions to Vania and 2 to Febby. Vania then gets the two
 * dates she asked for on 7 September and never received: 9 and 11 September,
 * dinner, one portion each. The 8th is gone — the food was never cooked.
 *
 * 9 September is past its 16:00 H-1 cutoff, so Thenie needs telling by hand.
 *
 * The 15 rows dated 2025-12-29..31 are NOT touched here: they were all written
 * by one bulk operation on 2026-06-24 and are a different problem.
 *
 *   set -a && . ./.env.local && set +a && pnpm tsx scripts/fix-wrong-year-rows.ts [--apply]
 */

import { createClient } from "@supabase/supabase-js";
import { requiredEnv } from "../src/lib/env";
import { deleteDelivery } from "../src/lib/orders/delivery-state";
import { recordDailyOrder } from "../src/lib/orders/record-daily-order";

const db = createClient(
  requiredEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  requiredEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ),
);

const APPLY = process.argv.includes("--apply");
const ACTOR = "drpramadyo@gmail.com";

const REASON =
  "Wrong-year row written by record_daily_order before the past-date guard was fixed (d92225b, 2026-09-07). The date can never reach a kitchen sheet, so the food was never cooked; deleting the row returns the portions to the customer's balance.";

// Read by id rather than by date, so a row that has already been dealt with is
// reported as missing instead of something else being deleted in its place.
const PHANTOMS = [
  { who: "Vania", phone: "+6281292339008", date: "2025-09-01", id: "cd3f731c" },
  { who: "Vania", phone: "+6281292339008", date: "2025-09-08", id: "6900b638" },
  { who: "Febby", phone: "+628111818475", date: "2024-09-05", id: "c736cea1" },
  { who: "Febby", phone: "+628111818475", date: "2024-09-06", id: "8a8be342" },
];

const VANIA_PHONE = "+6281292339008";
const OWED_DATES = ["2026-09-09", "2026-09-11"];

async function customerIdFor(phone: string): Promise<string> {
  const { data, error } = await db
    .from("customers")
    .select("id")
    .eq("phone_number", phone)
    .single();
  if (error || !data) throw new Error(`no customer ${phone}`);
  return data.id;
}

async function main() {
  console.log(APPLY ? "APPLY\n" : "DRY RUN (pass --apply to write)\n");

  for (const phantom of PHANTOMS) {
    const customerId = await customerIdFor(phantom.phone);
    const { data: rows, error } = await db
      .from("daily_deliveries")
      .select("id, delivery_date, meal_type, portions")
      .eq("customer_id", customerId)
      .eq("delivery_date", phantom.date);
    if (error) throw new Error(error.message);
    if (rows?.length !== 1) {
      throw new Error(
        `${phantom.who} ${phantom.date}: expected 1 row, got ${rows?.length ?? 0}`,
      );
    }
    const row = rows[0];
    // The id is in the header for a reader chasing this back to the audit; it
    // is checked so a re-run cannot delete a row someone has since replaced.
    if (!row.id.startsWith(phantom.id)) {
      throw new Error(
        `${phantom.who} ${phantom.date}: expected row ${phantom.id}, found ${row.id.slice(0, 8)}`,
      );
    }
    console.log(
      `${phantom.who} ${row.delivery_date} ${row.meal_type} x${row.portions}: delete`,
    );
    if (!APPLY) continue;
    await deleteDelivery({ db, id: row.id, actor: ACTOR, reason: REASON });
    console.log("  deleted + logged");
  }

  // Booked through the same path the bot uses, so the draw order, the quota
  // check, the kitchen's delivery days and the holiday calendar all apply.
  const { data: vania, error: vaniaError } = await db
    .from("customers")
    .select("id, name")
    .eq("phone_number", VANIA_PHONE)
    .single();
  if (vaniaError || !vania) throw new Error(`no customer ${VANIA_PHONE}`);

  console.log(`\nVania: book ${OWED_DATES.join(", ")} dinner x1`);
  if (APPLY) {
    const result = await recordDailyOrder({
      db,
      customerId: vania.id,
      phone: VANIA_PHONE,
      customerName: vania.name,
      input: { delivery_dates: OWED_DATES, meal_type: "dinner", portions: 1 },
    });
    console.log(`  ${JSON.stringify(result)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
