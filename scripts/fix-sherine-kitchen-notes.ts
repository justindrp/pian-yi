/**
 * Sherine Fayola asked on 2 Sep to add "tidak bisa makan cumi" and the bot
 * confirmed it was recorded, but customers.kitchen_notes still read only
 * "Tidak pedas" — so the restriction never reached the kitchen sheet.
 * Run with --apply to write it.
 */
import { createClient } from "@supabase/supabase-js";
import { logEdit } from "../src/lib/audit/log-edit";
import { requiredEnv } from "../src/lib/env";

const APPLY = process.argv.includes("--apply");
const ACTOR = "drpramadyo@gmail.com";
const CUSTOMER_ID = "de16913f-6fae-4c92-a6b8-cbb168833597";
const NEXT_NOTES = "Tidak pedas. Tidak bisa makan cumi.";

async function main() {
  const db = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    requiredEnv(
      "SUPABASE_SERVICE_ROLE_KEY",
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    ),
  );

  const { data: before, error } = await db
    .from("customers")
    .select("id,name,kitchen_notes")
    .eq("id", CUSTOMER_ID)
    .single();
  if (error) {
    console.log("ERR", JSON.stringify(error));
    return;
  }

  console.log("before:", JSON.stringify(before.kitchen_notes));
  console.log("after: ", JSON.stringify(NEXT_NOTES));
  if (!APPLY) {
    console.log("\ndry run — pass --apply to write");
    return;
  }

  const { error: upErr } = await db
    .from("customers")
    .update({ kitchen_notes: NEXT_NOTES })
    .eq("id", CUSTOMER_ID);
  if (upErr) {
    console.log("ERR", JSON.stringify(upErr));
    return;
  }

  await logEdit({
    db,
    actor: ACTOR,
    entityType: "customer",
    entityId: CUSTOMER_ID,
    action: "update_kitchen_notes",
    changes: {
      before: { kitchen_notes: before.kitchen_notes },
      after: { kitchen_notes: NEXT_NOTES },
      reason:
        "Audit of the 2026-09-10 sheet: customer asked on 2 Sep to record 'tidak bisa makan cumi' and the bot confirmed it, but kitchen_notes was never updated",
    },
  });
  console.log("applied");
}

main();
