import {
  extractJson,
  getAnthropicClient,
  HAIKU_MODEL,
  NO_THINKING,
} from "@/lib/claude/client";

export interface ValidateReplyParams {
  reply: string;
  customerName: string | null;
  customerNotes: string | null;
  customerState: string;
  /**
   * Both halves of "sisa kuota", because the prompt hands the model both and a
   * validator that only knows one of them rejects the other by construction.
   * Febby asked "untuk quota masih sisa berapa yaa?" on 2026-09-02 holding 2
   * portions bought-not-delivered and 0 unbooked. The correct answer — 2 — was
   * unsupported against a context that said only "0 of 30 portions not yet
   * scheduled", so it was blocked, regenerated, blocked again, and she got the
   * fallback template while an admin was pushed about a hallucination that
   * never happened. See `remainingToday` in loadCustomerSchedule.
   */
  activeOrder: {
    unbooked: number;
    packageSize: number;
    remainingToday: number;
  } | null;
  /**
   * The tail of the conversation, oldest first. Without it the validator sees
   * only what the database already knows, so the one turn where the bot reads
   * an order back before it exists — "8 porsi, mulai Rabu 19 Agustus" — is
   * unsupported by construction, and every new customer's confirmation is
   * blocked.
   *
   * `sentBy` carries the admin who hand-typed an outbound line (see
   * `loadValidationTranscript`). Those lines are rendered ADMIN and count as
   * verified; the bot's own lines are rendered BOT and count as nothing, or the
   * model could launder a hallucination by repeating it next turn.
   */
  transcript?: { role: string; content: string; sentBy?: string | null }[];
}

export interface ValidateReplyResult {
  valid: boolean;
  unsupportedClaims: string[];
}

/**
 * The instruction half of the validator prompt. It is identical on every call,
 * so it is passed as `system` rather than pasted into the user turn: the
 * provider caches on prompt prefix and only a stable prefix can hit that cache.
 * With the whole thing in one user message — CONTEXT first, instructions last —
 * nothing before the instructions ever repeated, so every validator call paid
 * the uncached rate for all of it. The user turn now carries only this
 * customer's data.
 */
const VALIDATOR_SYSTEM = `You check a customer service bot's draft reply against verified data about the customer.

The user turn gives you CONTEXT (verified data about this customer), optionally CONVERSATION SO FAR (this chat, each line marked CUSTOMER, ADMIN or BOT), and REPLY (the draft, in Indonesian).

Does REPLY state any customer-specific fact (the customer's name, remaining quota/portions, package size, order status, or payment status) that is NOT supported by CONTEXT? A field marked "unknown"/"none"/"no active order" in CONTEXT means that fact is not known — if REPLY states a specific value for it anyway, that is unsupported.

Do NOT flag general business info (menu, prices, delivery areas, policies, how quota works) — only flag claims about THIS customer's own data.

Anything a CUSTOMER line stated in CONVERSATION SO FAR is supported, even if CONTEXT does not have it yet: an order being agreed has not been saved, so reading back the portions, dates, address or requests the customer just gave is correct behaviour, not a hallucination.

An ADMIN line was typed by a human colleague of ours, not produced by the bot, so whatever it states — a price, a portion count, dates, an arrangement — is a verified fact as well, even when CONTEXT has no order for it. A draft that repeats or builds on an offer we ourselves made is correct behaviour. A BOT line is the bot's own earlier draft and supports nothing on its own: a claim that appears only in a BOT line and nowhere else is still unsupported.

Reply JSON only: {"valid": true} or {"valid": false, "unsupported_claims": ["..."]}`;

export async function validateReply(
  params: ValidateReplyParams,
): Promise<ValidateReplyResult> {
  const context = `Customer state: ${params.customerState}
Customer name (if known): ${params.customerName ?? "unknown"}
Customer notes / learned context: ${params.customerNotes?.trim() || "none"}
Active order quota: ${
    params.activeOrder
      ? `${params.activeOrder.remainingToday} portions bought and not yet delivered — this is the number a customer means by "sisa kuota" and it is a supported fact. Of those, ${params.activeOrder.unbooked} have no delivery date booked yet. Package size ${params.activeOrder.packageSize} portions.`
      : "no active order"
  }`;

  const transcript = (params.transcript ?? [])
    .map((m) => {
      if (m.role !== "assistant") return `CUSTOMER: ${m.content}`;
      return `${m.sentBy ? "ADMIN" : "BOT"}: ${m.content}`;
    })
    .join("\n");

  const prompt = `CONTEXT (verified data about this customer):
${context}
${transcript ? `\nCONVERSATION SO FAR (CUSTOMER = the customer, ADMIN = a human colleague of ours, BOT = the bot itself):\n${transcript}\n` : ""}
REPLY (a customer service bot's draft reply, in Indonesian):
"""
${params.reply}
"""`;

  let rawText = "";
  try {
    const client = getAnthropicClient();
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      ...NO_THINKING,
      max_tokens: 1000,
      system: VALIDATOR_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    rawText = extractJson(res);
    if (!rawText) {
      console.error(
        "[validate-reply] Haiku returned empty content, stop_reason:",
        res.stop_reason,
      );
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
    console.error(
      "[validate-reply] validator call failed, failing open:",
      (err as Error).message,
      "| rawText:",
      JSON.stringify(rawText.slice(0, 200)),
    );
    return { valid: true, unsupportedClaims: [] };
  }
}
