import type Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";

export type WhatsAppMessageStatus = "sent" | "delivered" | "read" | "failed";

/**
 * Every image we send is stored with the raw file URL as its `content` — that
 * is what the inbox renders. Fed back verbatim, the model sees past assistant
 * turns that are nothing but a Supabase link and copies the pattern: on
 * 2026-08-16 it answered "ini dia menu untuk minggu depan ya:" followed by the
 * bare storage URL as text, instead of calling `send_menu_image`. The customer
 * got a link they had to open by hand.
 *
 * So a URL never reaches the model as message text. Captions and labels do —
 * only content that is itself a bare link is replaced.
 */
export function historyContent(row: {
  role: string;
  content: string;
  message_type: string | null;
}): string {
  const isMedia =
    row.message_type === "image" || row.message_type === "document";
  if (!isMedia || !/^https?:\/\/\S+$/.test(row.content.trim()))
    return row.content;
  return row.role === "assistant"
    ? "[gambar terkirim ke customer]"
    : "[customer mengirim gambar]";
}

export async function loadHistory(
  customerId: string,
  limit = 20,
  sinceIso?: string,
): Promise<Anthropic.Messages.MessageParam[]> {
  const db = createAdminClient();
  let query = db
    .from("conversations")
    .select("role, content, message_type")
    .eq("customer_id", customerId)
    .in("role", ["user", "assistant"]);
  if (sinceIso) query = query.gt("created_at", sinceIso);
  const { data } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!data) return [];

  return data.reverse().map((row) => ({
    role: row.role as "user" | "assistant",
    content: historyContent(row),
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
  mediaUrl?: string;
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
      media_url: params.mediaUrl ?? null,
      whatsapp_status: params.whatsappStatus ?? null,
      whatsapp_status_updated_at: params.whatsappStatusUpdatedAt ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    // Identify the row: a bare message means a lost inbox line with no way to
    // tell which write dropped it.
    console.error(
      "[conversations] saveMessage failed:",
      error?.message,
      JSON.stringify({
        role: params.role,
        messageId: params.messageId ?? null,
        messageType: params.messageType ?? "text",
        preview: params.content.slice(0, 60),
      }),
    );
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
  errors?: Array<{ code: number; title: string; message?: string }>;
}): Promise<void> {
  const db = createAdminClient();
  const updates = {
    whatsapp_status: params.status,
    whatsapp_status_updated_at:
      params.statusUpdatedAt ?? new Date().toISOString(),
    ...(params.whatsappMessageId
      ? { message_id: params.whatsappMessageId }
      : {}),
    // Meta only ever explains a failure once, in the status webhook. Keep it on
    // the row — the log line it used to go to does not survive log rotation.
    whatsapp_error: params.errors?.length ? params.errors : null,
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
