import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import type { ModelRole } from "./model-tag";

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

export const SONNET_MODEL =
  process.env.CLAUDE_SONNET_MODEL ?? "claude-sonnet-5";
export const HAIKU_MODEL = process.env.CLAUDE_HAIKU_MODEL ?? "claude-haiku-4-5";

/**
 * The `conversations.model_used` value for a model-written message. See
 * `model-tag.ts` for why it carries the role and the model rather than either
 * one alone.
 */
export function modelTag(role: ModelRole): string {
  return `${role}:${role === "sonnet" ? SONNET_MODEL : HAIKU_MODEL}`;
}

// DeepSeek reasons by default (effort "high"), and its chain of thought is paid
// for out of the same max_tokens budget as the answer. Long reasoning therefore
// ate the whole budget and the response came back stop_reason "max_tokens" with
// a `thinking` block and no text at all — the bot went silent on live customers,
// learn-context stopped summarizing, and validate-reply returned nothing.
//
// Spread this into every messages.create call. Verified against the endpoint:
// with it, replies come back as a single `text` block; without it, every reply
// carries a `thinking` block first. The `{ reasoning: { effort: "none" } }` form
// that DeepSeek's thinking-mode guide gives for the Anthropic API is silently
// ignored there — only this one takes effect.
export const NO_THINKING = { thinking: { type: "disabled" } } as const;

// Reading response.content[0] assumes the first block is the answer, which is
// only true for non-reasoning models. A reasoning model puts a `thinking` block
// first, so content[0].type === "text" is false and the caller sees an empty
// reply even though the answer is sitting in a later block. Always pick the
// text blocks out by type.
export function extractText(response: Message): string {
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

// Same, for callers that JSON.parse the result: a reasoning model routinely
// wraps its JSON in a ```json fence, which JSON.parse chokes on.
export function extractJson(response: Message): string {
  return extractText(response)
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}
