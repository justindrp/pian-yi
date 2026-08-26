import type { SupabaseClient } from "@supabase/supabase-js";
import {
  extractText,
  getAnthropicClient,
  HAIKU_MODEL,
  NO_THINKING,
} from "@/lib/claude/client";
import { updateTokenCount } from "@/lib/claude/safety";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/database";

// The "Preferensi:" bullet label above is a contract, not a style choice.
// /dapur/[id] is unauthenticated, so it strips this whole block and re-admits
// only bullets matching PREF_BULLET — which requires that exact label. The
// summarizer was never told to emit it, so dietary facts landed under labels
// like "Pemesanan aktif" and never reached the kitchen. On 2026-08-25 Surya
// ordered 15 porsi tanpa nasi; the summary recorded it twice and Thenie's sheet
// showed a normal bento, caught by hand the evening before delivery. Changing
// the label here without changing PREF_BULLET there re-breaks it silently.
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
    ...NO_THINKING,
    // A reasoning model spends this budget on its thinking block before it
    // writes anything: at 300 the whole allowance went to thinking and the
    // response came back stop_reason "max_tokens" with no text at all. The
    // summary itself is still 3-6 bullets.
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: `Summarize this WhatsApp conversation into durable context for a catering customer-service chatbot.

Rules:
- Return Indonesian only.
- Keep 3-6 short bullet points.
- Include preferences, constraints, recurring questions, order intent, address or schedule context if present.
- Anything the kitchen has to act on while cooking or dropping off — dietary
  requests and restrictions (tanpa nasi, tidak pedas, tanpa seafood, alergi),
  portion notes, and drop-off instructions — MUST go in a bullet that begins
  with the exact label "Preferensi:". Put every such fact in that bullet, and
  never put a price, a total, a discount or a bank detail in it. Only bullets
  carrying this exact label are shown to the kitchen; the same fact written
  under any other label is invisible to them.
- Do not invent facts.
- Do not include temporary chatter, greetings, or exact payment/card details.

Transcript:
${transcript}`,
      },
    ],
  });

  const rawText = extractText(response);
  if (!rawText) {
    console.error(
      "[learn-context] empty content, stop_reason:",
      response.stop_reason,
      "block types:",
      response.content.map((b) => b.type).join(","),
    );
    throw new Error("Could not summarize conversation");
  }
  const summary = rawText;
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
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== "Not enough customer messages to learn") {
      console.error("[learn-context] failed:", msg);
    }
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
