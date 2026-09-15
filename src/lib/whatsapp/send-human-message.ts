import { saveMessage, updateMessageReceipt } from "@/lib/claude/conversation";
import { holdUntil } from "@/lib/customers/takeover";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

export interface SendHumanMessageParams {
  phone: string;
  text: string;
  /**
   * What `conversations.sent_by` records. Anything non-empty renders as ADMIN
   * to the reply validator and marks the line as ours rather than the bot's,
   * so it must name the actual sender — `script:manual-send` for a person
   * typing, `script:review-reply` for the chat-review cron.
   */
  sentBy: string;
  /** 0 = rely on the 30-minute inactivity clock alone. */
  holdHours?: number;
}

export interface SendHumanMessageResult {
  customerId: string;
  customerName: string | null;
  whatsappMessageId: string;
  conversationId: string | null;
}

/**
 * Sends one outbound message on the compose-box path — the one a human uses,
 * not the bot's — and leaves the thread in the state the inbox would leave it.
 * Extracted from `scripts/manual-send.ts` when the chat-review cron became a
 * second caller; both must write the same flags, because the flags are what
 * stop the bot talking over a reply that has just been sent.
 *
 * Throws when the 24h window is shut: an out-of-window send is refused by the
 * WABA anyway (error 131042, payment restriction), and the POST still returns
 * 200, so the only way to be sure is not to send.
 */
export async function sendHumanMessage(
  params: SendHumanMessageParams,
): Promise<SendHumanMessageResult> {
  const { phone, text, sentBy, holdHours = 0 } = params;
  const db = createAdminClient();

  const { data: cust, error } = await db
    .from("customers")
    .select("id, name")
    .eq("phone_number", phone)
    .single();
  if (error) throw new Error(error.message);
  if (!cust) throw new Error(`no customer ${phone}`);

  if ((await windowHoursOpen(phone)) >= 24) throw new Error("window shut");

  const whatsappMessageId = await sendTextMessage(phone, text);
  const conversationId = await saveMessage({
    customerId: cust.id,
    role: "assistant",
    content: text,
    modelUsed: "human",
    sentBy,
  });
  await updateMessageReceipt({
    conversationId,
    whatsappMessageId,
    status: "sent",
  });

  // Same stamp the inbox compose box writes. Without it a message sent from a
  // script did not even reset the 30-minute inactivity clock, so the bot could
  // auto-resume on top of a hand-written reply — which is what it did to
  // Carolin's refund thread on 2026-09-01.
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

  return {
    customerId: cust.id,
    customerName: cust.name,
    whatsappMessageId,
    conversationId,
  };
}

/** Hours since the customer's last inbound message; Infinity if they never wrote. */
export async function windowHoursOpen(phone: string): Promise<number> {
  const db = createAdminClient();
  const { data: cust } = await db
    .from("customers")
    .select("id")
    .eq("phone_number", phone)
    .single();
  if (!cust) return Number.POSITIVE_INFINITY;

  const { data: last } = await db
    .from("conversations")
    .select("created_at")
    .eq("customer_id", cust.id)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return last?.created_at
    ? (Date.now() - new Date(last.created_at).getTime()) / 3_600_000
    : Number.POSITIVE_INFINITY;
}
