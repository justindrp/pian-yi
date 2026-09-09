/**
 * Takes Vania's thread (The Brooklyn SOHO, +6281292339008) off the bot for the
 * Julian mix-up on 8 September.
 *
 * Deliberately NOT the two-hour hold the Take over button offers. She cannot
 * reply until she reopens her window, which may be days, and the bot knows
 * nothing about the missing Selasa row or whose bag was on the drop-off desk.
 * `shouldAutoResume()` never resumes a thread whose `last_human_activity_at` is
 * null, so that is what this writes: held until a human hands it back.
 *
 * The reason the 24-hour hold was removed is that a silenced thread swallows a
 * customer nobody is watching. scripts/watch-vania.ts is the compensating
 * control — it must be running, or this is the Sherine Fayola failure again.
 */
import { logEdit } from "../src/lib/audit/log-edit";
import { createAdminClient } from "../src/lib/supabase/admin";

const CUSTOMER_ID = "2ca04f0d-d448-4b79-aa5e-7c5140ee6dd6";
const REASON =
  "Julian mix-up 8 Sept — she asked for a Selasa 8/9 dinner that was never booked, and Julian's bag was left on the Brooklyn drop-off desk that night. Bot has none of this context. Held indefinitely; hand back with escalated:false once settled.";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { data: before } = await db
    .from("customer_flags")
    .select("escalated_to_human, escalation_reason, hold_until, last_human_activity_at")
    .eq("customer_id", CUSTOMER_ID)
    .maybeSingle();
  console.log("before:", JSON.stringify(before));

  const next = {
    customer_id: CUSTOMER_ID,
    escalated_to_human: true,
    escalation_reason: REASON,
    // Null on purpose — see the header. A timestamp here starts the 30-minute
    // auto-resume clock and hands her back to a bot that cannot help her.
    last_human_activity_at: null,
    hold_until: null,
    pending_bot_response: false,
    pending_bot_question: null,
  };
  console.log("after: ", JSON.stringify(next));
  if (!apply) return console.log("\ndry run — pass --apply");

  const { error } = await db.from("customer_flags").upsert(next);
  if (error) throw error;
  await logEdit({
    db,
    actor: "drpramadyo@gmail.com",
    entityType: "customer",
    entityId: CUSTOMER_ID,
    action: "takeover",
    changes: { from: before, to: next },
  });
  console.log("\ntaken over — bot is off this thread until someone resumes it");
}

main().catch((e) => {
  console.log(`ERR ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  process.exit(1);
});
