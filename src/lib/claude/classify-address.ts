import { getAnthropicClient, SONNET_MODEL } from "./client";

export type AddressType = "house" | "apartment" | "office";

export async function classifyAddress(address: string): Promise<AddressType> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 10,
    messages: [
      {
        role: "user",
        content: `Classify this delivery address as exactly one of: house, apartment, office.\n\nAddress: ${address}\n\nReply with only the single word.`,
      },
    ],
  });

  const text =
    response.content[0].type === "text"
      ? response.content[0].text.trim().toLowerCase()
      : "";

  if (text === "house" || text === "apartment" || text === "office") return text;
  return "house";
}
