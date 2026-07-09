import type { MessageParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { getAnthropicClient, SONNET_MODEL } from "@/lib/claude/client";
import { getAssistantSystemPrompt } from "@/lib/claude/assistant-prompt";
import { assistantTools, runTool, isWriteTool, buildPendingAction } from "@/lib/claude/assistant-tools";
import { createConversation, saveTurn } from "@/lib/claude/assistant-history";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_TURNS = 5;

export async function analyzeCustomerMessage({
  customerId,
  customerName,
  text,
}: {
  customerId: string;
  customerName: string | null;
  text: string;
}): Promise<{ conversationId: string | null }> {
  const db = createAdminClient();
  const client = getAnthropicClient();

  const displayName = customerName ?? customerId;
  const userText = `Pesan dari pelanggan ${displayName} (customer_id: ${customerId}): "${text}"`;

  const conversationId = await createConversation(db);
  if (!conversationId) return { conversationId: null };

  const currentMessages: MessageParam[] = [{ role: "user", content: userText }];
  let assistantText = "";
  let pendingAction: Record<string, unknown> | null = null;

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
      assistantText = textBlock?.type === "text" ? textBlock.text : "";
      break;
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      const writeBlocks = toolUseBlocks.filter((b) => b.type === "tool_use" && isWriteTool(b.name));

      if (writeBlocks.length > 0) {
        const proposalText = response.content.find((b) => b.type === "text");
        assistantText = proposalText?.type === "text" ? proposalText.text : "";
        pendingAction = await buildPendingAction(
          writeBlocks[0].name,
          writeBlocks[0].input as Record<string, unknown>,
        ) as unknown as Record<string, unknown>;
        break;
      }

      currentMessages.push({ role: "assistant", content: response.content });
      const toolResults: ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async (block) => {
          if (block.type !== "tool_use") {
            return { type: "tool_result" as const, tool_use_id: "", content: "" };
          }
          const result = await runTool(block.name, block.input as Record<string, unknown>);
          return { type: "tool_result" as const, tool_use_id: block.id, content: JSON.stringify(result) };
        }),
      );
      currentMessages.push({ role: "user", content: toolResults });
      continue;
    }
    break;
  }

  await saveTurn(db, {
    conversationId,
    userText,
    assistantText,
    isFirstMessage: true,
  });

  if (pendingAction) {
    await db
      .from("assistant_conversations")
      // biome-ignore lint/suspicious/noExplicitAny: jsonb column not in generated types yet
      .update({ pending_action: pendingAction } as any)
      .eq("id", conversationId);
  }

  await sendPushToAllAdmins(
    `Permintaan dari ${displayName}`,
    assistantText || text.slice(0, 80),
    "/assistant",
    pendingAction ? "high" : "medium",
  ).catch((err) => console.error("[analyzeCustomerMessage] push failed:", err));

  return { conversationId };
}
