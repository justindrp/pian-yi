import { HAIKU_MODEL, NO_THINKING, extractJson, getAnthropicClient } from "@/lib/claude/client";

export interface ValidateReplyParams {
  reply: string;
  customerName: string | null;
  customerNotes: string | null;
  customerState: string;
  activeOrder: { portionsRemaining: number; packageSize: number } | null;
  /**
   * The tail of the conversation, oldest first. Without it the validator sees
   * only what the database already knows, so the one turn where the bot reads
   * an order back before it exists — "8 porsi, mulai Rabu 19 Agustus" — is
   * unsupported by construction, and every new customer's confirmation is
   * blocked.
   */
  transcript?: { role: string; content: string }[];
}

export interface ValidateReplyResult {
  valid: boolean;
  unsupportedClaims: string[];
}

export async function validateReply(
  params: ValidateReplyParams,
): Promise<ValidateReplyResult> {
  const context = `Customer state: ${params.customerState}
Customer name (if known): ${params.customerName ?? "unknown"}
Customer notes / learned context: ${params.customerNotes?.trim() || "none"}
Active order quota: ${params.activeOrder ? `${params.activeOrder.portionsRemaining} / ${params.activeOrder.packageSize} portions remaining` : "no active order"}`;

  const transcript = (params.transcript ?? [])
    .map((m) => `${m.role === "assistant" ? "BOT" : "CUSTOMER"}: ${m.content}`)
    .join("\n");

  const prompt = `CONTEXT (verified data about this customer):
${context}
${transcript ? `\nCONVERSATION SO FAR (what the customer has told us in this chat):\n${transcript}\n` : ""}
REPLY (a customer service bot's draft reply, in Indonesian):
"""
${params.reply}
"""

Does REPLY state any customer-specific fact (the customer's name, remaining quota/portions, package size, order status, or payment status) that is NOT supported by CONTEXT? A field marked "unknown"/"none"/"no active order" in CONTEXT means that fact is not known — if REPLY states a specific value for it anyway, that is unsupported.

Do NOT flag general business info (menu, prices, delivery areas, policies, how quota works) — only flag claims about THIS customer's own data.

Anything the customer stated in CONVERSATION SO FAR is supported, even if CONTEXT does not have it yet: an order being agreed has not been saved, so reading back the portions, dates, address or requests the customer just gave is correct behaviour, not a hallucination.

Reply JSON only: {"valid": true} or {"valid": false, "unsupported_claims": ["..."]}`;

  let rawText = "";
  try {
    const client = getAnthropicClient();
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      ...NO_THINKING,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });
    rawText = extractJson(res);
    if (!rawText) {
      console.error("[validate-reply] Haiku returned empty content, stop_reason:", res.stop_reason);
      return { valid: true, unsupportedClaims: [] };
    }
    const parsed = JSON.parse(rawText) as {
      valid: boolean;
      unsupported_claims?: string[];
    };
    return {
      valid: parsed.valid !== false,
      unsupportedClaims: parsed.unsupported_claims ?? [],
    };
  } catch (err) {
    console.error("[validate-reply] validator call failed, failing open:", (err as Error).message, "| rawText:", JSON.stringify(rawText.slice(0, 200)));
    return { valid: true, unsupportedClaims: [] };
  }
}
