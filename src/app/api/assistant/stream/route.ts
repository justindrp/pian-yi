import type {
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { NextResponse } from "next/server";
import { NO_THINKING, SONNET_MODEL, getAnthropicClient } from "@/lib/claude/client";
import { getAssistantSystemPrompt } from "@/lib/claude/assistant-prompt";
import {
  assistantTools,
  runTool,
  isWriteTool,
  buildPendingAction,
} from "@/lib/claude/assistant-tools";
import { describeToolCall, summarizeToolResult } from "@/lib/claude/assistant-steps";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createConversation, saveTurn } from "@/lib/claude/assistant-history";
import type { Json } from "@/types/database";

// Streaming twin of POST /api/assistant. Same loop, same write-tool
// interception — the difference is that text and tool steps reach the admin as
// they happen instead of after every turn has finished. That is what makes a
// deep loop usable: the old route did all its work behind a blank spinner, so
// the turn budget had to stay small enough to fit inside a browser's patience.
// Because the admin can now watch and cancel, the budget can be generous.
const MAX_TURNS = 25;

type StreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "text"; delta: string }
  | { type: "step"; id: string; label: string }
  | { type: "step_done"; id: string; summary: string }
  | { type: "pending_action"; pendingAction: unknown }
  | { type: "done" }
  | { type: "error"; error: string };

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

  const db = createAdminClient();
  let conversationId = incomingId;
  if (!conversationId) {
    conversationId = (await createConversation(db)) ?? undefined;
  }
  const lastUserText = extractLastUserText(messages);
  const isFirstMessage = !incomingId && lastUserText !== null;

  const client = getAnthropicClient();
  const currentMessages: MessageParam[] = [...messages];
  const encoder = new TextEncoder();

  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Everything the admin saw, narration included — that is what gets saved,
      // so reopening the thread shows the same thing the live run did.
      let fullText = "";
      let closed = false;

      function send(event: StreamEvent) {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      async function persist() {
        if (!conversationId) return;
        await saveTurn(db, {
          conversationId,
          userText: lastUserText ?? "",
          assistantText: fullText,
          isFirstMessage,
        });
      }

      try {
        if (conversationId) send({ type: "conversation", conversationId });

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          // The admin closed the tab or hit Stop. Keep whatever was produced.
          if (request.signal.aborted) break;

          const stream = client.messages.stream(
            {
              model: SONNET_MODEL,
              ...NO_THINKING,
              max_tokens: 2000,
              system: await getAssistantSystemPrompt(),
              tools: assistantTools,
              messages: currentMessages,
            },
            { signal: request.signal },
          );

          stream.on("text", (delta) => {
            fullText += delta;
            send({ type: "text", delta });
          });

          const response = await stream.finalMessage();

          if (response.stop_reason === "end_turn") {
            await persist();
            send({ type: "done" });
            return;
          }

          if (response.stop_reason === "tool_use") {
            const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
            if (toolUseBlocks.length === 0) break;

            const writeBlocks = toolUseBlocks.filter((b) => isWriteTool(b.name));
            if (writeBlocks.length > 0) {
              const pendingAction =
                writeBlocks.length === 1 ||
                !writeBlocks.every((block) => isBatchableWriteTool(block.name))
                  ? await buildPendingAction(
                      writeBlocks[0].name,
                      writeBlocks[0].input as Record<string, unknown>,
                    )
                  : await buildBatchPendingAction(writeBlocks);
              await persist();
              if (conversationId) {
                await db
                  .from("assistant_conversations")
                  // PendingAction carries Record<string, unknown> tool input,
                  // which TS won't narrow to Json even though it always
                  // serializes to one.
                  .update({ pending_action: pendingAction as unknown as Json })
                  .eq("id", conversationId);
              }
              send({ type: "pending_action", pendingAction });
              send({ type: "done" });
              return;
            }

            currentMessages.push({ role: "assistant", content: response.content });

            const toolResults: ToolResultBlockParam[] = await Promise.all(
              toolUseBlocks.map(async (block) => {
                const input = block.input as Record<string, unknown>;
                send({
                  type: "step",
                  id: block.id,
                  label: describeToolCall(block.name, input),
                });
                const result = await runTool(block.name, input);
                send({
                  type: "step_done",
                  id: block.id,
                  summary: summarizeToolResult(result),
                });
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

          console.error(
            `[assistant/stream] loop stopped early: stop_reason=${response.stop_reason} turn=${turn}`,
          );
          break;
        }

        // Ran out of turns, or stopped for a reason we can't continue from
        // (max_tokens above all). Ask once more with the tools removed so the
        // model has to answer from the lookups already in context.
        if (!request.signal.aborted) {
          const wrapUp = await client.messages.stream(
            {
              model: SONNET_MODEL,
              ...NO_THINKING,
              max_tokens: 2000,
              system: await getAssistantSystemPrompt(),
              messages: currentMessages,
            },
            { signal: request.signal },
          );
          wrapUp.on("text", (delta) => {
            fullText += delta;
            send({ type: "text", delta });
          });
          await wrapUp.finalMessage();
        }

        if (!fullText) {
          console.error(
            `[assistant/stream] no response after ${MAX_TURNS} turns; messages=${currentMessages.length}`,
          );
          send({ type: "error", error: "Tidak ada jawaban. Coba lagi ya." });
        } else {
          await persist();
        }
        send({ type: "done" });
      } catch (err) {
        // An abort is the admin pressing Stop, not a failure — keep the partial
        // answer rather than throwing it away.
        if (request.signal.aborted) {
          if (fullText) await persist().catch(() => {});
        } else {
          console.error("[assistant/stream] failed:", err);
          send({
            type: "error",
            error: err instanceof Error ? err.message : "Terjadi kesalahan",
          });
        }
        send({ type: "done" });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(sse, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Railway's proxy will otherwise buffer the whole response and deliver it
      // in one lump, which looks exactly like the blank spinner we're removing.
      "X-Accel-Buffering": "no",
    },
  });
}

function isBatchableWriteTool(name: string): boolean {
  return name === "send_whatsapp_message" || name === "send_whatsapp_image";
}

async function buildBatchPendingAction(
  writeBlocks: Array<{ name: string; input: unknown }>,
) {
  const actions = await Promise.all(
    writeBlocks.map((block) =>
      buildPendingAction(block.name, block.input as Record<string, unknown>),
    ),
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
export const maxDuration = 300;
