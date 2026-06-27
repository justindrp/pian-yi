import { type NextRequest, NextResponse } from "next/server";
import { getAnthropicClient, HAIKU_MODEL } from "@/lib/claude/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const START = "[AI learned context]";
const END = "[/AI learned context]";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const body = (await req.json()) as { customer_id?: string };
  const customerId = body.customer_id;
  if (!customerId) {
    return NextResponse.json(
      { ok: false, error: "customer_id required" },
      { status: 400 },
    );
  }

  const db = createAdminClient();
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
    return NextResponse.json(
      { ok: false, error: "Customer not found" },
      { status: 404 },
    );
  }

  const chronological = (messages ?? []).reverse();
  if (chronological.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No conversation to learn" },
      { status: 400 },
    );
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
    return NextResponse.json(
      { ok: false, error: "Could not summarize conversation" },
      { status: 500 },
    );
  }

  const notes = replaceLearnedBlock(customer.notes ?? "", summary);
  const { error } = await db
    .from("customers")
    .update({ notes })
    .eq("id", customerId);
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, summary });
}

function replaceLearnedBlock(notes: string, summary: string): string {
  const block = `${START}\n${summary}\n${END}`;
  const pattern = new RegExp(
    `${escapeRegex(START)}[\\s\\S]*?${escapeRegex(END)}`,
  );
  const trimmed = notes.trim();
  if (pattern.test(trimmed)) return trimmed.replace(pattern, block);
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const dynamic = "force-dynamic";
