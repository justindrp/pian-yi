import { processSavedCustomerMessage } from "@/app/api/webhook/whatsapp/route";
import type { createAdminClient } from "@/lib/supabase/admin";

type Db = ReturnType<typeof createAdminClient>;

export type ReplayResult = {
  replayed: boolean;
  reason?: string;
  draft?: string;
  status?: number;
};

// Re-runs a customer's latest saved inbound message through the normal chatbot
// flow. Two callers share this: the admin inbox (a button) and the auto-resume
// cron (a thread handed back to the bot with the customer's last message still
// unanswered). They must agree on the guards — a reply the cron sends on its
// own is held to exactly the same conditions as one an admin asks for.
export async function replayLatestCustomerMessage(
  customerId: string,
  db: Db,
  { draft = false }: { draft?: boolean } = {},
): Promise<ReplayResult> {
  const [
    { data: customer, error: customerError },
    { data: flags, error: flagError },
    { data: latestMessage, error: latestError },
    { data: stateRow },
    { data: latestOrder },
  ] = await Promise.all([
    db
      .from("customers")
      .select("id, name, phone_number, notes")
      .eq("id", customerId)
      .single(),
    db
      .from("customer_flags")
      .select("escalated_to_human, pending_bot_response, is_blacklisted")
      .eq("customer_id", customerId)
      .single(),
    db
      .from("conversations")
      .select("role, content, message_id, message_type")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single(),
    db
      .from("customer_state")
      .select("state, menu_shown")
      .eq("customer_id", customerId)
      .single(),
    db
      .from("orders")
      .select("status")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single(),
  ]);

  if (customerError || !customer) {
    return { replayed: false, reason: "customer_not_found", status: 404 };
  }
  if (flagError || !flags) {
    return { replayed: false, reason: "flags_not_found", status: 404 };
  }
  if (latestError || !latestMessage) {
    return { replayed: false, reason: "no_messages", status: 404 };
  }
  if (flags.is_blacklisted) {
    return { replayed: false, reason: "blacklisted" };
  }
  // The latest message being the customer's is what makes a replay safe: it
  // means nobody has answered them yet. If an admin replied last, there is
  // nothing owed and re-running would talk over the human.
  if (latestMessage.role !== "user") {
    return { replayed: false, reason: "latest_not_user" };
  }
  if ((latestMessage.message_type ?? "text") !== "text") {
    return { replayed: false, reason: "latest_not_text" };
  }
  if (!latestMessage.content?.trim()) {
    return { replayed: false, reason: "empty_message" };
  }

  const draftText = await processSavedCustomerMessage({
    customerId: customer.id,
    customerName: customer.name,
    customerNotes: (customer as { notes?: string | null }).notes ?? null,
    latestOrderStatus: latestOrder?.status ?? null,
    phone: customer.phone_number,
    stateRow: stateRow ?? null,
    text: latestMessage.content,
    messageId: latestMessage.message_id ?? null,
    draft,
  });

  if (draft) {
    if (!draftText) return { replayed: false, reason: "empty_draft" };
    return { replayed: true, draft: draftText };
  }

  return { replayed: true };
}
