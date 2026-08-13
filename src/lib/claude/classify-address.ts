import { NO_THINKING, SONNET_MODEL, extractText, getAnthropicClient } from "./client";

export type AddressType = "house" | "apartment" | "office";

export async function classifyAddress(address: string): Promise<AddressType> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: SONNET_MODEL,
    ...NO_THINKING,
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `Classify this delivery address as exactly one of: house, apartment, office.\n\nAddress: ${address}\n\nReply with only the single word.`,
      },
    ],
  });

  const text = extractText(response).toLowerCase();

  if (text === "house" || text === "apartment" || text === "office") return text;
  return "house";
}
