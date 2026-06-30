import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropicClient, HAIKU_MODEL } from "@/lib/claude/client";
import { updateTokenCount } from "@/lib/claude/safety";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/database";

export const LEARNED_CONTEXT_START = "[AI learned context]";
export const LEARNED_CONTEXT_END = "[/AI learned context]";

type AdminDb = SupabaseClient<Database>;

export async function learnCustomerContext(
  customerId: string,
  db: AdminDb = createAdminClient(),
): Promise<{ summary: string; notes: string }> {
  const [{ data: customer }, { data: messages }] = await Promise.all([
    db.from("customers").select("id, notes").eq("id", customerId).single(),
    db
      .from("conversations")
      .select("role, content, message_type, created_at")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(80),
  ]);

  if (!customer) {
    throw new Error("Customer not found");
  }

  const chronological = (messages ?? []).reverse();
  const userMessages = chronological.filter((m) => m.role === "user");
  if (userMessages.length < 3) {
    throw new Error("Not enough customer messages to learn");
  }

  const transcript = chronological
    .map((m) => {
      const label = m.role === "user" ? "Customer" : "Pian Yi";
      const content = m.message_type === "image" ? "[image]" : m.content;
      return `${label}: ${content}`;
    })
    .join("\n");

  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `Summarize this WhatsApp conversation into durable context for a catering customer-service chatbot.

Rules:
- Return Indonesian only.
- Keep 3-6 short bullet points.
- Include preferences, constraints, recurring questions, order intent, address or schedule context if present.
- Do not invent facts.
- Do not include temporary chatter, greetings, or exact payment/card details.

Transcript:
${transcript}`,
      },
    ],
  });

  const summary =
    response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
  if (!summary) {
    throw new Error("Could not summarize conversation");
  }
  await updateTokenCount(
    customerId,
    response.usage.input_tokens + response.usage.output_tokens,
  );

  const notes = replaceLearnedBlock(customer.notes ?? "", summary);
  const { error } = await db
    .from("customers")
    .update({ notes })
    .eq("id", customerId);
  if (error) {
    throw new Error(error.message);
  }

  return { summary, notes };
}

export async function tryLearnCustomerContext(
  customerId: string,
  db: AdminDb = createAdminClient(),
): Promise<string | null> {
  try {
    const learned = await learnCustomerContext(customerId, db);
    return learned.notes;
  } catch (err) {
    console.error(
      "[learn-context] failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function replaceLearnedBlock(notes: string, summary: string): string {
  const block = `${LEARNED_CONTEXT_START}\n${summary}\n${LEARNED_CONTEXT_END}`;
  const pattern = new RegExp(
    `${escapeRegex(LEARNED_CONTEXT_START)}[\\s\\S]*?${escapeRegex(LEARNED_CONTEXT_END)}`,
  );
  const trimmed = notes.trim();
  if (pattern.test(trimmed)) return trimmed.replace(pattern, block);
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
