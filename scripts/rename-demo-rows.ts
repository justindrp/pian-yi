/**
 * Demo customers seeded by the replay harness keep the real customer's name, so
 * the inbox shows two threads with the same name and an admin can reply to the
 * wrong one. Rename any demo row that is not already labelled.
 */
import { demoDisplayName, isDemoPhone } from "../src/lib/whatsapp/demo";
import { createAdminClient } from "../src/lib/supabase/admin";

async function main() {
  const db = createAdminClient();
  const { data } = await db
    .from("customers")
    .select("id, name, phone_number")
    .ilike("phone_number", "%DEMO%");
  for (const row of data ?? []) {
    if (!isDemoPhone(row.phone_number)) continue;
    const want = demoDisplayName(row.phone_number);
    if (row.name === want) continue;
    await db.from("customers").update({ name: want }).eq("id", row.id);
    console.log(`renamed demo row: ${row.name} -> ${want}`);
  }
}

main();
