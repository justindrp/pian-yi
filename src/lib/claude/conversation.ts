import type Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";

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
}): Promise<void> {
  const db = createAdminClient();
  await db.from("conversations").insert({
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
  });
}
