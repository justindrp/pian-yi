import type Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";

export type WhatsAppMessageStatus = "sent" | "delivered" | "read" | "failed";

export async function loadHistory(
  customerId: string,
): Promise<Anthropic.Messages.MessageParam[]> {
  const db = createAdminClient();
  const { data } = await db
    .from("conversations")
    .select("role, content")
    .eq("customer_id", customerId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: true })
    .limit(20);

  if (!data) return [];

  return data.map((row) => ({
    role: row.role as "user" | "assistant",
    content: row.content,
  }));
}

export async function saveMessage(params: {
  customerId: string;
  role: "user" | "assistant";
  content: string;
  messageId?: string;
  modelUsed?: string;
  inputTokens?: number;
  outputTokens?: number;
  intent?: string;
  messageType?: string;
  mediaId?: string;
  whatsappStatus?: WhatsAppMessageStatus;
  whatsappStatusUpdatedAt?: string;
}): Promise<string | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("conversations")
    .insert({
      customer_id: params.customerId,
      role: params.role,
      content: params.content,
      message_id: params.messageId ?? null,
      model_used: params.modelUsed ?? null,
      input_tokens: params.inputTokens ?? null,
      output_tokens: params.outputTokens ?? null,
      intent: params.intent ?? null,
      message_type: params.messageType ?? "text",
      media_id: params.mediaId ?? null,
      whatsapp_status: params.whatsappStatus ?? null,
      whatsapp_status_updated_at: params.whatsappStatusUpdatedAt ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[conversations] saveMessage failed:", error?.message);
    return null;
  }

  return data.id;
}

export async function updateMessageReceipt(params: {
  conversationId?: string | null;
  messageId?: string | null;
  whatsappMessageId?: string | null;
  status: WhatsAppMessageStatus;
  statusUpdatedAt?: string;
}): Promise<void> {
  const db = createAdminClient();
  const updates = {
    whatsapp_status: params.status,
    whatsapp_status_updated_at:
      params.statusUpdatedAt ?? new Date().toISOString(),
    ...(params.whatsappMessageId
      ? { message_id: params.whatsappMessageId }
      : {}),
  };

  let query = db.from("conversations").update(updates);
  if (params.conversationId) {
    query = query.eq("id", params.conversationId);
  } else if (params.messageId) {
    query = query.eq("message_id", params.messageId);
  } else {
    return;
  }

  const { error } = await query;
  if (error) {
    console.error(
      "[conversations] updateMessageReceipt failed:",
      error.message,
    );
  }
}
