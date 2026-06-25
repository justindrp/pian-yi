import type { MessageParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { NextResponse } from "next/server";
import { getAnthropicClient, SONNET_MODEL } from "@/lib/claude/client";
import { getAssistantSystemPrompt } from "@/lib/claude/assistant-prompt";
import { assistantTools, runTool } from "@/lib/claude/assistant-tools";
import { getSessionWithRole } from "@/lib/supabase/get-role";

export async function POST(request: Request) {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { messages?: MessageParam[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ ok: false, error: "messages required" }, { status: 400 });
  }

  const client = getAnthropicClient();
  const currentMessages: MessageParam[] = [...messages];
  const MAX_TURNS = 5;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 2000,
      system: getAssistantSystemPrompt(),
      tools: assistantTools,
      messages: currentMessages,
    });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      const text = textBlock?.type === "text" ? textBlock.text : "";
      return NextResponse.json({ ok: true, text });
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) break;

      currentMessages.push({ role: "assistant", content: response.content });

      const toolResults: ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async (block) => {
          if (block.type !== "tool_use") {
            return { type: "tool_result" as const, tool_use_id: "", content: "" };
          }
          const result = await runTool(
            block.name,
            block.input as Record<string, unknown>,
          );
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: JSON.stringify(result),
          };
        }),
      );

      currentMessages.push({ role: "user", content: toolResults });
      continue;
    }

    break;
  }

  const lastMsg = currentMessages.at(-1);
  if (lastMsg?.role === "assistant") {
    const content = lastMsg.content;
    if (typeof content === "string") {
      return NextResponse.json({ ok: true, text: content });
    }
    if (Array.isArray(content)) {
      const textBlock = content.find((b) => typeof b === "object" && b.type === "text");
      if (textBlock && typeof textBlock === "object" && textBlock.type === "text") {
        return NextResponse.json({ ok: true, text: textBlock.text });
      }
    }
  }

  return NextResponse.json({ ok: true, text: "I couldn't generate a response. Please try again." });
}
