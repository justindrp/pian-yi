/**
 * Sends one hand-written message to a customer and logs it to conversations,
 * the way the inbox compose box does. For driving a thread the bot has parked.
 *   tsx scripts/manual-send.ts +62... "text" [--apply]
 */
import { saveMessage, updateMessageReceipt } from "../src/lib/claude/conversation";
import { createAdminClient } from "../src/lib/supabase/admin";
import { sendTextMessage } from "../src/lib/whatsapp/client";

async function main() {
  const [phone, text] = process.argv.slice(2);
  const apply = process.argv.includes("--apply");
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

  console.log(`${cust.name ?? "(no name)"} ${phone} — window ${hours < 24 ? "OPEN" : "SHUT"} (${hours.toFixed(1)}h)\n${text}\n`);
  if (!apply) return console.log("dry run — pass --apply");
  if (hours >= 24) throw new Error("window shut");

  const messageId = await sendTextMessage(phone, text);
  const conversationId = await saveMessage({
    customerId: cust.id,
    role: "assistant",
    content: text,
    modelUsed: "human",
  });
  await updateMessageReceipt({ conversationId, whatsappMessageId: messageId, status: "sent" });
  console.log(`sent — ${messageId}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
