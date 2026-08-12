import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";

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
