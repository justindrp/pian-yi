/**
 * Three one-off delivery corrections found by the 2026-09-07 audit of Thenie's
 * 8 September sheet, where a chat request had been acknowledged to the customer
 * but never written to `daily_deliveries`:
 *
 *   1. Nadya    2026-09-08 dinner -> lunch  (asked 09-07 09:33 WIB, before cutoff)
 *   2. Cindi    2026-09-08 address_slot 2 -> 1  (Kost Platinum, asked 09-06 23:14 WIB)
 *   3. Puspa    2026-09-11 -> 2026-09-12  (asked 09-06, still open with the team)
 *
 * Nadya and Cindi are past the 16:00 H-1 cutoff, so the kitchen sheet for the
 * 8th has already gone out — both need telling by hand as well as here.
 *
 *   set -a && . ./.env.local && set +a && pnpm tsx scripts/fix-0908-sheet-corrections.ts [--apply]
 */

import { createClient } from "@supabase/supabase-js";
import { requiredEnv } from "../src/lib/env";
import { logEdit } from "../src/lib/audit/log-edit";

const db = createClient(
  requiredEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY),
);

const APPLY = process.argv.includes("--apply");
const ACTOR = "drpramadyo@gmail.com";

type Fix = {
  who: string;
  date: string;
  match: { meal_type?: string };
  patch: Record<string, string | number>;
  reason: string;
};

const FIXES: Fix[] = [
  {
    who: "Nadya",
    date: "2026-09-08",
    match: { meal_type: "dinner" },
    patch: { meal_type: "lunch" },
    reason:
      "Customer asked on 2026-09-07 09:33 WIB to move 8 Sep from dinner to lunch, before the 16:00 H-1 cutoff. The bot confirmed the change in chat but wrote nothing.",
  },
  {
    who: "Cindi",
    date: "2026-09-08",
    match: { meal_type: "lunch" },
    patch: { address_slot: 1 },
    reason:
      "Customer asked on 2026-09-06 23:14 WIB to deliver 8 Sep to Kost Platinum (slot 1) instead of UPH Gate 2 (slot 2), before the cutoff. The bot confirmed and wrote nothing.",
  },
  {
    who: "Puspa Marcom",
    date: "2026-09-11",
    match: { meal_type: "lunch" },
    patch: { delivery_date: "2026-09-12" },
    reason:
      "Customer asked on 2026-09-06 to move 11 Sep to 12 Sep; approved by Justin on 2026-09-07. 12 Sep is a Saturday and Thenie delivers Mon-Sat.",
  },
];

async function main() {
  console.log(APPLY ? "APPLY\n" : "DRY RUN (pass --apply to write)\n");

  for (const fix of FIXES) {
    const { data: customers } = await db
      .from("customers")
      .select("id,name")
      .ilike("name", `${fix.who}%`);
    if (customers?.length !== 1) {
      throw new Error(`${fix.who}: expected 1 customer, got ${customers?.length ?? 0}`);
    }
    const customer = customers[0];

    let q = db
      .from("daily_deliveries")
      .select("*")
      .eq("customer_id", customer.id)
      .eq("delivery_date", fix.date);
    if (fix.match.meal_type) q = q.eq("meal_type", fix.match.meal_type);
    const { data: rows } = await q;
    if (rows?.length !== 1) {
      throw new Error(
        `${fix.who} ${fix.date}: expected 1 row, got ${rows?.length ?? 0}`,
      );
    }
    const row = rows[0];

    const before = Object.fromEntries(
      Object.keys(fix.patch).map((k) => [k, (row as Record<string, unknown>)[k]]),
    );
    console.log(
      `${fix.who} ${fix.date} row ${row.id.slice(0, 8)}: ${JSON.stringify(before)} -> ${JSON.stringify(fix.patch)}`,
    );

    if (!APPLY) continue;

    const { error } = await db
      .from("daily_deliveries")
      .update(fix.patch)
      .eq("id", row.id);
    if (error) throw new Error(`${fix.who}: ${error.message}`);

    await logEdit({
      db,
      actor: ACTOR,
      entityType: "daily_deliveries",
      entityId: row.id,
      action: "correct_delivery",
      changes: { reason: fix.reason, before, after: fix.patch },
    });
    console.log("  applied + logged");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
