/**
 * Tiara (+628118006788), from her 2026-09-08 chat, which the bot escalated and
 * nobody actioned:
 *
 *   07:53-07:58 — asks to go back to nasi lengkap. She had taken "tanpa nasi"
 *                 on the understanding it came with +25% protein, which it does
 *                 not; the bot admitted the earlier information was wrong.
 *   08:03-08:26 — asks for +1 porsi per delivery day, and settles on five extra
 *                 lunch portions so the total reaches the 5-porsi minimum.
 *
 * Her open order 06c91ede (6 porsi lunch, 7-12 Sep) has two delivered (7, 8 Sep)
 * and four still to eat, currently one a day on 9, 10, 11 and 12 Sep. She eats
 * two a day from now on, so those four become 9 and 10 Sep at 2 porsi, and the
 * new package covers Jumat onwards.
 *
 *   1. 2026-09-09 lunch 1 -> 2 porsi   (old order)
 *   2. 2026-09-10 lunch 1 -> 2 porsi   (old order)
 *   3. 2026-09-11, 2026-09-12 rows deleted — those portions moved to 9 and 10
 *   4. new order: 5 porsi lunch, Thenie, 11 Sep x2, 12 Sep x2, 14 Sep x1,
 *      Rp 29.000/porsi = Rp 145.000, bank details sent on creation
 *   5. `kitchen_notes` "tanpa nasi" cleared — every remaining delivery is the
 *      full portion with rice
 *
 * 9 September is past its 16:00 H-1 cutoff, so the kitchen sheet for tomorrow
 * has already gone out: the extra portion and the rice both need telling to
 * Thenie by hand as well as here.
 *
 * The new order's delivery rows land when it is marked paid, not here.
 *
 *   set -a && . ./.env.local && set +a && pnpm tsx scripts/fix-tiara-0908.ts [--apply]
 */

import { createClient } from "@supabase/supabase-js";
import { logEdit } from "../src/lib/audit/log-edit";
import { createOrderFromExtraction } from "../src/lib/claude/extract-order";
import { requiredEnv } from "../src/lib/env";
import { deleteDelivery } from "../src/lib/orders/delivery-state";

const db = createClient(
  requiredEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  requiredEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ),
);

const APPLY = process.argv.includes("--apply");
const ACTOR = "drpramadyo@gmail.com";
const PHONE = "+628118006788";
const THENIE = "52cd5e62-da09-49c9-939c-2f1246566c40";

const REASON =
  "Customer asked on 2026-09-08 08:03 WIB for one extra lunch portion a day and settled at 08:25 on five extra portions. Her four undelivered portions are re-dated to two a day on 9 and 10 Sep; the new package covers 11, 12 and 14 Sep.";

const REPORTIONS = [
  { date: "2026-09-09", portions: 2 },
  { date: "2026-09-10", portions: 2 },
];
const DROP = ["2026-09-11", "2026-09-12"];

async function main() {
  console.log(APPLY ? "APPLY\n" : "DRY RUN (pass --apply to write)\n");

  const { data: customer, error: custError } = await db
    .from("customers")
    .select("id, name, kitchen_notes")
    .eq("phone_number", PHONE)
    .single();
  if (custError || !customer) throw new Error(`no customer ${PHONE}`);

  const { data: rows, error: rowsError } = await db
    .from("daily_deliveries")
    .select("id, delivery_date, meal_type, portions")
    .eq("customer_id", customer.id)
    .gte("delivery_date", "2026-09-09")
    .order("delivery_date");
  if (rowsError) throw new Error(rowsError.message);

  const byDate = new Map((rows ?? []).map((r) => [r.delivery_date, r]));

  // 1 + 2 — the two days she still eats off the old package.
  for (const { date, portions } of REPORTIONS) {
    const row = byDate.get(date);
    if (!row) throw new Error(`no row on ${date}`);
    console.log(
      `${date} ${row.meal_type}: ${row.portions} -> ${portions} porsi`,
    );
    if (!APPLY) continue;

    const { error } = await db
      .from("daily_deliveries")
      .update({ portions })
      .eq("id", row.id);
    if (error) throw new Error(error.message);
    await logEdit({
      db,
      actor: ACTOR,
      entityType: "daily_deliveries",
      entityId: row.id,
      action: "correct_delivery",
      changes: {
        reason: REASON,
        before: { portions: row.portions },
        after: { portions },
      },
    });
    console.log("  applied + logged");
  }

  // 3 — the portions those two rows held are now on 9 and 10 Sep.
  for (const date of DROP) {
    const row = byDate.get(date);
    if (!row) throw new Error(`no row on ${date}`);
    console.log(`${date} ${row.meal_type} x${row.portions}: delete`);
    if (!APPLY) continue;
    await deleteDelivery({ db, id: row.id, actor: ACTOR, reason: REASON });
    console.log("  deleted + logged");
  }

  // 4 — the new package. Address, area and maps link are left empty on purpose:
  // every field there is only written when this order carries one, and hers are
  // already on record.
  console.log(
    "\nnew order: 5 porsi lunch, Thenie — 11 Sep x2, 12 Sep x2, 14 Sep x1",
  );
  if (APPLY) {
    const result = await createOrderFromExtraction(customer.id, PHONE, {
      customer_name: customer.name ?? "Tiara",
      package_size: 5,
      portions_per_delivery: 2,
      address: "",
      maps_link: "",
      area: "",
      size: "s",
      subcontractor_id: THENIE,
      delivery_schedule: [
        { date: "2026-09-11", meal_type: "lunch", portions: 2 },
        { date: "2026-09-12", meal_type: "lunch", portions: 2 },
        { date: "2026-09-14", meal_type: "lunch", portions: 1 },
      ],
    });
    console.log(`  ${JSON.stringify(result)}`);
  }

  // 5 — cleared last, because createOrderFromExtraction rewrites kitchen_notes
  // from what it finds on the record.
  console.log(
    `\nkitchen_notes: ${JSON.stringify(customer.kitchen_notes)} -> null`,
  );
  if (APPLY) {
    const { error } = await db
      .from("customers")
      .update({ kitchen_notes: null })
      .eq("id", customer.id);
    if (error) throw new Error(error.message);
    await logEdit({
      db,
      actor: ACTOR,
      entityType: "customers",
      entityId: customer.id,
      action: "update_kitchen_notes",
      changes: {
        reason:
          "Customer asked on 2026-09-08 07:58 WIB to go back to nasi lengkap: 'Yaudah ini tambahin nasi ya yg diantar'. She took tanpa nasi believing it carried +25% protein, which it does not.",
        before: { kitchen_notes: customer.kitchen_notes },
        after: { kitchen_notes: null },
      },
    });
    console.log("  applied + logged");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
