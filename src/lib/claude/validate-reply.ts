import { getAnthropicClient, HAIKU_MODEL } from "@/lib/claude/client";

export interface ValidateReplyParams {
  reply: string;
  customerName: string | null;
  customerNotes: string | null;
  customerState: string;
  activeOrder: { portionsRemaining: number; packageSize: number } | null;
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

  const prompt = `CONTEXT (verified data about this customer):
${context}

REPLY (a customer service bot's draft reply, in Indonesian):
"""
${params.reply}
"""

Does REPLY state any customer-specific fact (the customer's name, remaining quota/portions, package size, order status, or payment status) that is NOT supported by CONTEXT? A field marked "unknown"/"none"/"no active order" in CONTEXT means that fact is not known — if REPLY states a specific value for it anyway, that is unsupported.

Do NOT flag general business info (menu, prices, delivery areas, policies, how quota works) — only flag claims about THIS customer's own data.

Reply JSON only: {"valid": true} or {"valid": false, "unsupported_claims": ["..."]}`;

  try {
    const client = getAnthropicClient();
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text =
      res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const parsed = JSON.parse(text) as {
      valid: boolean;
      unsupported_claims?: string[];
    };
    return {
      valid: parsed.valid !== false,
      unsupportedClaims: parsed.unsupported_claims ?? [],
    };
  } catch (err) {
    console.error("[validate-reply] validator call failed, failing open:", (err as Error).message);
    return { valid: true, unsupportedClaims: [] };
  }
}
