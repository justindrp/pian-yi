import { logEdit } from "@/lib/audit/log-edit";
import { createAdminClient } from "@/lib/supabase/admin";

const ORDER = "a4bef23a-cf85-4e09-b59e-775d4209e377";
const ACTOR = "justindrp2@gmail.com";

async function main() {
  const db = createAdminClient();
  const { data: before, error } = await db
    .from("orders")
    .select("id,start_date,end_date")
    .eq("id", ORDER)
    .single();
  if (error || !before) throw new Error(`lookup failed: ${error?.message}`);
  console.log("before:", before);
  if (before.start_date === "2026-08-24") {
    console.log("already correct");
    return;
  }

  const { error: upErr } = await db
    .from("orders")
    .update({ start_date: "2026-08-24" })
    .eq("id", ORDER);
  if (upErr) throw new Error(upErr.message);

  await logEdit({
    db,
    actor: ACTOR,
    entityType: "order",
    entityId: ORDER,
    action: "update",
    changes: {
      start_date: { from: before.start_date, to: "2026-08-24" },
      reason:
        "bot refused Senin 24 on a bad holiday check; schedule now starts Senin",
    },
  });
  const { data: after } = await db
    .from("orders")
    .select("id,start_date")
    .eq("id", ORDER)
    .single();
  console.log("after:", after);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
