import { getAnthropicClient, HAIKU_MODEL } from "@/lib/claude/client";

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
    max_tokens: 20,
    messages: [{ role: "user", content: message }],
    system:
      "Classify this WhatsApp message into one of these categories: faq, ordering, complaint, payment, other. Reply with only the category word.",
  });

  const content = response.content[0];
  const text =
    content.type === "text" ? content.text.trim().toLowerCase() : "other";
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
