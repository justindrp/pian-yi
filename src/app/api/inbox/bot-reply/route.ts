import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getAnthropicClient, HAIKU_MODEL } from "@/lib/claude/client";
import { sendTextMessage } from "@/lib/whatsapp/client";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { customer_id: string; admin_answer: string };
  const { customer_id, admin_answer } = body;

  if (!customer_id || !admin_answer?.trim()) {
    return NextResponse.json({ ok: false, error: "customer_id and admin_answer required" }, { status: 400 });
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

  // Polish admin's raw answer into warm Indonesian bot voice via Haiku
  const anthropic = getAnthropicClient();
  const polishResult = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `You are rewriting an admin's concise internal note as a warm, polite WhatsApp reply from a catering bot.

Rules:
- Reply in Indonesian only
- Use "kak" as honorific where natural
- Keep it short (under 80 words)
- Sound warm and human, not robotic
- Do not add information beyond what the admin provided
- Do not use markdown (no **, no #)
- Do not greet with "Halo kak" — go straight to the answer
- Do not mention that this came from an admin

Customer's question: ${flags.pending_bot_question ?? "(not recorded)"}
Admin's answer: ${admin_answer}

Rewrite the admin's answer as the bot's reply:`,
      },
    ],
  });

  const polishedText =
    polishResult.content[0].type === "text" ? polishResult.content[0].text.trim() : admin_answer;

  await sendTextMessage(customer.phone_number, polishedText);

  await db
    .from("customer_flags")
    .update({ pending_bot_response: false, pending_bot_question: null })
    .eq("customer_id", customer_id);

  return NextResponse.json({ ok: true, sent: polishedText });
}

export const dynamic = "force-dynamic";
