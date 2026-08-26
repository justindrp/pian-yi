import {
  extractText,
  getAnthropicClient,
  HAIKU_MODEL,
  NO_THINKING,
} from "@/lib/claude/client";

export type MessageIntent =
  | "faq"
  | "ordering"
  | "complaint"
  | "payment"
  | "other";

export async function classifyIntent(message: string): Promise<MessageIntent> {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    ...NO_THINKING,
    max_tokens: 500,
    messages: [{ role: "user", content: message }],
    system:
      "Classify this WhatsApp message into one of these categories: faq, ordering, complaint, payment, other. Reply with only the category word.",
  });

  const text = extractText(response).toLowerCase() || "other";
  const valid: MessageIntent[] = [
    "faq",
    "ordering",
    "complaint",
    "payment",
    "other",
  ];
  return valid.includes(text as MessageIntent)
    ? (text as MessageIntent)
    : "other";
}
