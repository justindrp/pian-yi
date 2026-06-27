import type { MessageParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { NextResponse } from "next/server";
import { getAnthropicClient, SONNET_MODEL } from "@/lib/claude/client";
import { getAssistantSystemPrompt } from "@/lib/claude/assistant-prompt";
import { assistantTools, runTool, isWriteTool, buildPendingAction } from "@/lib/claude/assistant-tools";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createConversation, saveTurn } from "@/lib/claude/assistant-history";

export async function POST(request: Request) {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { messages?: MessageParam[]; conversationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { messages, conversationId: incomingId } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ ok: false, error: "messages required" }, { status: 400 });
  }

  // Resolve (or lazily create) the conversation thread this turn belongs to.
  const db = createAdminClient();
  let conversationId = incomingId;
  if (!conversationId) {
    conversationId = (await createConversation(db)) ?? undefined;
  }
  const lastUserText = extractLastUserText(messages);
  const isFirstMessage = !incomingId && lastUserText !== null;

  const client = getAnthropicClient();
  const currentMessages: MessageParam[] = [...messages];
  const MAX_TURNS = 5;

  // Persist this turn (user msg + assistant reply) to the thread.
  async function persist(assistantText: string) {
    if (!conversationId) return;
    await saveTurn(db, {
      conversationId,
      userText: lastUserText ?? "",
      assistantText,
      isFirstMessage,
    });
  }

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
      await persist(text);
      return NextResponse.json({ ok: true, text, conversationId });
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) break;

      const writeBlocks = toolUseBlocks.filter((b) => b.type === "tool_use" && isWriteTool(b.name));
      if (writeBlocks.length > 0) {
        const proposalText = response.content.find((b) => b.type === "text");
        const text = proposalText?.type === "text" ? proposalText.text : "";
        const pendingAction = writeBlocks.length === 1 || !writeBlocks.every((block) => isBatchableWriteTool(block.name))
          ? await buildPendingAction(
              writeBlocks[0].name,
              writeBlocks[0].input as Record<string, unknown>,
            )
          : await buildBatchPendingAction(writeBlocks);
        await persist(text);
        return NextResponse.json({ ok: true, text, pendingAction, conversationId });
      }

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
      await persist(content);
      return NextResponse.json({ ok: true, text: content, conversationId });
    }
    if (Array.isArray(content)) {
      const textBlock = content.find((b) => typeof b === "object" && b.type === "text");
      if (textBlock && typeof textBlock === "object" && textBlock.type === "text") {
        await persist(textBlock.text);
        return NextResponse.json({ ok: true, text: textBlock.text, conversationId });
      }
    }
  }

  return NextResponse.json({ ok: true, text: "I couldn't generate a response. Please try again.", conversationId });
}

function isBatchableWriteTool(name: string): boolean {
  return name === "send_whatsapp_message" || name === "send_whatsapp_image";
}

async function buildBatchPendingAction(
  writeBlocks: Array<{ name: string; input: unknown }>,
) {
  const actions = await Promise.all(
    writeBlocks.map((block) => buildPendingAction(block.name, block.input as Record<string, unknown>)),
  );

  return {
    tool: "batch",
    input: {
      actions: writeBlocks.map((block) => ({
        tool: block.name,
        input: block.input as Record<string, unknown>,
      })),
    },
    label: `Confirm ${actions.length} actions`,
    details: actions.flatMap((action, index) => [
      `${index + 1}. ${action.label}`,
      ...action.details,
    ]),
    dangerous: actions.some((action) => action.dangerous),
  };
}

function extractLastUserText(messages: MessageParam[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.find((b) => typeof b === "object" && b.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      if (text) return text.text;
    }
  }
  return null;
}

export const dynamic = "force-dynamic";
