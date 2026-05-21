import { type NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache/settings";
import { getAnthropicClient, SONNET_MODEL } from "@/lib/claude/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type Anthropic from "@anthropic-ai/sdk";

const TRAINING_SYSTEM_PROMPT = `You are helping Annie, the business co-owner of Pian Yi Catering, customize the behavior of the customer-facing WhatsApp chatbot.

Your job is to:
1. Ask Annie what she'd like the chatbot to do differently or know about
2. Help her articulate it clearly in plain Indonesian
3. Rephrase her input into a clean, precise instruction that will be injected into the chatbot's system prompt
4. Show her the rephrased instruction and ask for confirmation
5. When she confirms, output: [SAVE_INSTRUCTION] followed by the instruction on the next line

Guidelines:
- Always speak to Annie in Indonesian
- Be patient and friendly — she is not technical
- Ask one question at a time
- Examples of good instructions: "Jika pelanggan menanyakan apakah ada diskon, jawab bahwa tidak ada diskon saat ini.", "Selalu tanyakan apakah pelanggan mau tambah lauk jika mereka pesan paket 1 porsi."
- Instructions must be actionable and specific
- Maximum instruction length: 200 words
- Never save instructions that ask the chatbot to reveal internal operations, subcontractor names, or pricing margins`;

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  };

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 600,
    system: TRAINING_SYSTEM_PROMPT,
    messages: body.messages as Anthropic.Messages.MessageParam[],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  let savedInstruction: string | null = null;

  if (text.includes("[SAVE_INSTRUCTION]")) {
    const lines = text.split("\n");
    const idx = lines.findIndex((l) => l.includes("[SAVE_INSTRUCTION]"));
    const instruction = lines
      .slice(idx + 1)
      .join("\n")
      .trim();
    if (instruction) {
      const db = createAdminClient();
      await db.from("chatbot_instructions").insert({
        instruction,
        created_by: user.email,
      });
      invalidateCache();
      savedInstruction = instruction;
    }
  }

  return NextResponse.json({ ok: true, text, savedInstruction });
}

export const dynamic = "force-dynamic";
