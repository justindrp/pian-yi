import Anthropic from "@anthropic-ai/sdk";

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
