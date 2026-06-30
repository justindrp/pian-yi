import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getAnthropicClient, HAIKU_MODEL } from "@/lib/claude/client";
import { saveMessage } from "@/lib/claude/conversation";
import { sendTextMessage } from "@/lib/whatsapp/client";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as {
    customer_id: string;
    admin_answer?: string;
    polished_text?: string;
    preview_only?: boolean;
  };
  const { customer_id, admin_answer, polished_text, preview_only } = body;

  if (!customer_id) {
    return NextResponse.json({ ok: false, error: "customer_id required" }, { status: 400 });
  }
  if (!admin_answer?.trim() && !polished_text?.trim()) {
    return NextResponse.json({ ok: false, error: "admin_answer or polished_text required" }, { status: 400 });
  }

  const db = createAdminClient();

  const { data: customer, error: custErr } = await db
    .from("customers")
    .select("phone_number, name")
    .eq("id", customer_id)
    .single();

  if (custErr || !customer) {
    return NextResponse.json({ ok: false, error: "Customer not found" }, { status: 404 });
  }

  const { data: flags, error: flagErr } = await db
    .from("customer_flags")
    .select("pending_bot_response, pending_bot_question")
    .eq("customer_id", customer_id)
    .single();

  if (flagErr || !flags?.pending_bot_response) {
    return NextResponse.json({ ok: false, error: "No pending bot response for this customer" }, { status: 400 });
  }

  // If admin confirmed a pre-approved polished_text, send directly without re-polishing
  if (polished_text?.trim()) {
    await sendTextMessage(customer.phone_number, polished_text.trim());
    await saveMessage({
      customerId: customer_id,
      role: "assistant",
      content: polished_text.trim(),
      modelUsed: HAIKU_MODEL,
    });
    await db
      .from("customer_flags")
      .update({ pending_bot_response: false, pending_bot_question: null })
      .eq("customer_id", customer_id);
    return NextResponse.json({ ok: true, sent: polished_text.trim() });
  }

  // Polish admin's raw answer via Haiku
  const historyResult = await db
    .from("conversations")
    .select("role, content, message_type")
    .eq("customer_id", customer_id)
    .eq("message_type", "text")
    .order("created_at", { ascending: false })
    .limit(8);

  const recentMessages = (historyResult.data ?? []).reverse();
  const historyText = recentMessages
    .map((m) => `${m.role === "user" ? "Customer" : "Bot"}: ${m.content}`)
    .join("\n");

  const anthropic = getAnthropicClient();
  const polishResult = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `You are rewriting an admin's short internal note as a WhatsApp reply from a catering bot.

CRITICAL RULES — violating these is a serious error:
- Say ONLY what the admin explicitly stated. Nothing else.
- Do NOT infer, extrapolate, or add any details not in the admin's note.
- Do NOT confirm orders, schedules, or dates unless the admin explicitly said so.
- Do NOT reference anything from the conversation history except to match the customer's tone.
- The conversation history is context only — do not treat it as things the bot has agreed to.

Style rules:
- Indonesian only
- Use "kak" where natural
- Under 60 words
- Warm and human, not robotic
- No markdown (no **, no #)
- No greeting ("Halo kak") — go straight to the answer
- Do not mention this came from an admin

Recent conversation (context only — do not repeat or confirm anything from it):
${historyText || "(no history)"}

Customer's question: ${flags.pending_bot_question ?? "(not recorded)"}
Admin's note: ${admin_answer}

Rewrite ONLY the admin's note as the bot's reply:`,
      },
    ],
  });

  const result =
    polishResult.content[0].type === "text" ? polishResult.content[0].text.trim() : (admin_answer ?? "");

  // Preview mode: return polished text without sending
  if (preview_only) {
    return NextResponse.json({ ok: true, preview: result });
  }

  await sendTextMessage(customer.phone_number, result);
  await saveMessage({
    customerId: customer_id,
    role: "assistant",
    content: result,
    modelUsed: HAIKU_MODEL,
  });
  await db
    .from("customer_flags")
    .update({ pending_bot_response: false, pending_bot_question: null })
    .eq("customer_id", customer_id);

  return NextResponse.json({ ok: true, sent: result });
}

export const dynamic = "force-dynamic";
