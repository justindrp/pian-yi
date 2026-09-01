/**
 * Sends one hand-written message to a customer and logs it to conversations,
 * the way the inbox compose box does. For driving a thread the bot has parked.
 *   tsx scripts/manual-send.ts +62... "text" [--apply] [--hold-hours N]
 */
import {
  saveMessage,
  updateMessageReceipt,
} from "../src/lib/claude/conversation";
import { holdUntil } from "../src/lib/customers/takeover";
import { createAdminClient } from "../src/lib/supabase/admin";
import { sendTextMessage } from "../src/lib/whatsapp/client";

// Longest a thread may be held from here. A hold is for waiting on something
// that happens today — a transfer, a courier, a decision — and one that
// outlives that is how a customer ends up talking to nobody.
const MAX_HOLD_HOURS = 24;

async function main() {
  const [phone, text] = process.argv.slice(2);
  const apply = process.argv.includes("--apply");
  const holdFlag = process.argv.indexOf("--hold-hours");
  const holdHours = holdFlag === -1 ? 0 : Number(process.argv[holdFlag + 1]);
  if (holdHours < 0 || holdHours > MAX_HOLD_HOURS || Number.isNaN(holdHours)) {
    throw new Error(`--hold-hours must be 0..${MAX_HOLD_HOURS}`);
  }
  const db = createAdminClient();

  const { data: cust } = await db
    .from("customers")
    .select("id, name")
    .eq("phone_number", phone)
    .single();
  if (!cust) throw new Error(`no customer ${phone}`);

  const { data: last } = await db
    .from("conversations")
    .select("created_at")
    .eq("customer_id", cust.id)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  const hours = last?.created_at
    ? (Date.now() - new Date(last.created_at).getTime()) / 3_600_000
    : Number.POSITIVE_INFINITY;

  console.log(
    `${cust.name ?? "(no name)"} ${phone} — window ${hours < 24 ? "OPEN" : "SHUT"} (${hours.toFixed(1)}h)\n${text}\n`,
  );
  if (!apply) return console.log("dry run — pass --apply");
  if (hours >= 24) throw new Error("window shut");

  const messageId = await sendTextMessage(phone, text);
  const conversationId = await saveMessage({
    customerId: cust.id,
    role: "assistant",
    content: text,
    modelUsed: "human",
    // Nobody pressed a button in the dashboard for this one, so it is marked as
    // the script rather than left blank, which would read as a bot message.
    sentBy: "script:manual-send",
  });
  await updateMessageReceipt({
    conversationId,
    whatsappMessageId: messageId,
    status: "sent",
  });

  // Same stamp the inbox compose box writes. Without it a message sent from
  // here did not even reset the 30-minute inactivity clock, so the bot could
  // auto-resume on top of a hand-written reply — which is what it did to
  // Carolin's refund thread on 2026-09-01. `--hold-hours` holds it longer than
  // the clock, for a thread waiting on something off WhatsApp.
  await db
    .from("customer_flags")
    .update({
      last_human_activity_at: new Date().toISOString(),
      pending_bot_response: false,
      pending_bot_question: null,
      ...(holdHours
        ? { escalated_to_human: true, hold_until: holdUntil(holdHours * 60) }
        : {}),
    })
    .eq("customer_id", cust.id);

  console.log(
    `sent — ${messageId}${holdHours ? ` — bot held ${holdHours}h` : ""}`,
  );
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
