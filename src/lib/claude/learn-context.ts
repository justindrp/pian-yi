import type { SupabaseClient } from "@supabase/supabase-js";
import {
  extractText,
  getAnthropicClient,
  HAIKU_MODEL,
  NO_THINKING,
} from "@/lib/claude/client";
import { updateTokenCount } from "@/lib/claude/safety";
import { logEdit, systemActor } from "@/lib/audit/log-edit";
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
  requests and restrictions, portion notes, and drop-off instructions — MUST go
  in a bullet that begins with the exact label "Preferensi:". Put every such
  fact in that bullet, and never put a price, a total, a discount or a bank
  detail in it. Record only what the customer asked for, never what we do about
  it internally: write their request as they made it, never the protein
  increase we arrange with the kitchen in return for it. This bullet does not
  reach the kitchen — customers.kitchen_notes does, and only an admin or an
  accepted order writes that — so a request recorded here still has to be acted
  on by a person.
- A restriction goes in that bullet ONLY if the customer stated it themselves,
  in their own message, in this transcript. Use their words. If they stated
  none, the bullet must read exactly "Preferensi: tidak ada permintaan khusus."
  — never a list of plausible restrictions, never a restriction because it is
  common, and never one lifted from these instructions rather than the
  transcript. A customer who is told about a restriction, or asked whether they
  have one and says no, has not stated one. The chatbot is handed this bullet
  on every turn and answers from it: on 2026-08-31 Carolin asked "ini tanpa
  nasi?" about a restriction she had never given, and the bot confirmed it back
  to her because the bullet said so.
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

  // This overwrites a whole block of a customer's record from a model output,
  // and until now left no trace of what it replaced. When Carolin's kitchen
  // card said "tanpa nasi" on 2026-09-01 there was no way to prove what the
  // summarizer had written the night before, only to infer it from the label on
  // the bag. The block no longer reaches the kitchen, but it still feeds the
  // bot, so what it said and when has to be reconstructable.
  await logEdit({
    db,
    actor: systemActor("learn-context"),
    entityType: "customers",
    entityId: customerId,
    action: "learn_context",
    changes: { before: customer.notes ?? null, after: notes },
  });

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
