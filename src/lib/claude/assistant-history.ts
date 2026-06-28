import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export type AssistantDb = SupabaseClient<Database>;

export type ConversationRow = {
  id: string;
  title: string;
  updated_at: string;
};

export type AssistantMessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const MAX_TITLE = 40;

function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_TITLE
    ? `${clean.slice(0, MAX_TITLE)}…`
    : clean || "New chat";
}

/** Create an empty conversation, return its id. */
export async function createConversation(
  db: AssistantDb,
): Promise<string | null> {
  const { data, error } = await db
    .from("assistant_conversations")
    .insert({})
    .select("id")
    .single();
  if (error || !data) {
    console.error("[assistant-history] createConversation:", error);
    return null;
  }
  return data.id;
}

/** Insert the user + assistant message rows for a turn; set title on first message. */
export async function saveTurn(
  db: AssistantDb,
  args: {
    conversationId: string;
    userText: string;
    assistantText: string;
    isFirstMessage: boolean;
  },
): Promise<void> {
  const rows: Array<Pick<AssistantMessageRow, "role" | "content">> = [];
  if (args.userText) rows.push({ role: "user", content: args.userText });
  if (args.assistantText)
    rows.push({ role: "assistant", content: args.assistantText });
  if (rows.length === 0) return;

  const { error: msgErr } = await db.from("assistant_messages").insert(
    rows.map((r) => ({
      conversation_id: args.conversationId,
      role: r.role,
      content: r.content,
    })),
  );
  if (msgErr) {
    console.error("[assistant-history] saveTurn insert:", msgErr);
    return;
  }

  const update: { updated_at: string; title?: string } = {
    updated_at: new Date().toISOString(),
  };
  if (args.isFirstMessage && args.userText) {
    update.title = deriveTitle(args.userText);
  }
  await db
    .from("assistant_conversations")
    .update(update)
    .eq("id", args.conversationId);
}

/** Persist a single assistant reply (e.g. after a confirmed write action). */
export async function saveAssistantReply(
  db: AssistantDb,
  conversationId: string,
  assistantText: string,
): Promise<void> {
  if (!assistantText) return;
  const { error } = await db.from("assistant_messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content: assistantText,
  });
  if (error) {
    console.error("[assistant-history] saveAssistantReply:", error);
    return;
  }
  await db
    .from("assistant_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

export async function listConversations(
  db: AssistantDb,
): Promise<ConversationRow[]> {
  const { data, error } = await db
    .from("assistant_conversations")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("[assistant-history] listConversations:", error);
    return [];
  }
  return (data ?? []) as ConversationRow[];
}

export async function getMessages(
  db: AssistantDb,
  id: string,
): Promise<AssistantMessageRow[]> {
  const { data, error } = await db
    .from("assistant_messages")
    .select("id, role, content")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[assistant-history] getMessages:", error);
    return [];
  }
  return (data ?? []) as AssistantMessageRow[];
}
