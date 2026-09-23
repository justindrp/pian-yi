import {
  extractJson,
  getAnthropicClient,
  HAIKU_MODEL,
  NO_THINKING,
} from "@/lib/claude/client";
import { getSetting } from "@/lib/cache/settings";
import { mentionsTeamMember, parseTeamRoster } from "@/lib/claude/team-roster";

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
   * The delivery dates already on the calendar, from the same read as
   * `activeOrder`. Without them CONTEXT holds no dates at all, so every date in
   * a draft was unsupported by construction and the checker said so: on
   * 2026-09-20 16.15 Vania lost two drafts in a row over "Selasa 22, Rabu 23,
   * dan Jumat 25 September masih bisa dijadwalkan" and got the fallback
   * template. A date is a customer record like a quota is, and it is checkable
   * once it is here.
   */
  upcoming?: { date: string; mealType: string; portions: number }[];
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
/**
 * The six fields a draft can be wrong about. Every flag must name one, and a
 * flag naming anything else is dropped in code rather than argued with in
 * prose.
 *
 * Free-text flags were the whole false-positive surface: asked the open
 * question "does REPLY state a fact CONTEXT does not support", Haiku answers it
 * about the reply as a whole, and a reply is mostly business info — prices, the
 * menu, which days a kitchen works, whether a date is past the cutoff. None of
 * that is in CONTEXT, because CONTEXT is one customer's record, so "not in
 * CONTEXT" fires on all of it. Telling it not to did not work: on 2026-09-20
 * three drafts were blocked 6 times out of 6 over per-kitchen no-rice
 * discounts, a menu date range and the 16.00 cutoff, and the instruction
 * waiving business info was already in the prompt and had been since August.
 * Naming the field is a different question — a closed one — and a discount has
 * no field to be filed under.
 */
const CLAIM_FIELDS = [
  "name",
  "quota",
  "package_size",
  "order_status",
  "payment_status",
] as const;

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

CONTEXT is one customer's record and holds six fields, listed here with the only thing that counts as a claim about each:

- "name" — REPLY addresses the customer by a name.
- "quota" — REPLY states how many porsi they have left. CONTEXT gives this as two numbers and BOTH are correct: the portions bought and not yet delivered, and, of those, the portions with no delivery date yet. Quoting either is supported; only a third number is a claim.
- "package_size" — REPLY states how many porsi they bought.
- "order_status" — REPLY states that their order is active, paused, finished or cancelled.
- "payment_status" — REPLY states that they have or have not paid, or that we did or did not receive their proof.
Report a claim only when REPLY states a value for one of those six and CONTEXT does not show that value. Every claim you report must name its field, and there is no seventh field. If something in REPLY looks wrong to you but fits none of the six, REPLY is valid: say so and stop.

This matters most for the things CONTEXT never holds — prices, discounts, the menu, delivery areas, which days or hours a kitchen works, public holidays, the order cutoff, whether a date is locked or still open, the names of our partner kitchens. Those come from the bot's own instructions, which are written from our database and are true. They have no field, so they are never claims, however specific the number or the date. Delivery dates are listed in CONTEXT as background for the quota numbers; a date in REPLY is not a claim about any of the five fields.

A field CONTEXT marks "unknown", "none" or "no active order" means we have no record of it, so a draft stating a specific value for it is a claim. A draft that does not mention it, or that asks the customer for it, is not.

Anything a CUSTOMER line stated in CONVERSATION SO FAR is supported, even if CONTEXT does not have it yet: an order being agreed has not been saved, so reading back the portions, dates, address or requests the customer just gave is correct behaviour, not a hallucination.

An ADMIN line was typed by a human colleague of ours, not produced by the bot, so whatever it states — a price, a portion count, dates, an arrangement — is a verified fact as well, even when CONTEXT has no order for it. A draft that repeats or builds on an offer we ourselves made is correct behaviour. A BOT line is the bot's own earlier draft and supports nothing on its own: a claim that appears only in a BOT line and nowhere else is still unsupported.

Reply with JSON and nothing else — no explanation before or after it. Either:
{"valid": true}
or:
{"valid": false, "unsupported_claims": [{"field": "quota", "claim": "the words in REPLY that state it"}]}
"field" must be one of: ${CLAIM_FIELDS.join(", ")}.`;

/**
 * Words that mean this thread is about a one-off event rather than a daily
 * package. The same list the system prompt treats as an event signal.
 */
const EVENT_WORDS =
  /\b(acara|event|ulang tahun|arisan|pengajian|seminar|syukuran|buka puasa|tumpeng|prasmanan|nasi box|nasi kotak|snack box|coffee break|gathering|catering kantor)\b/i;

export function mentionsEvent(text: string): boolean {
  return EVENT_WORDS.test(text ?? "");
}

/**
 * A line that names the daily package alongside the event word is contrasting
 * the two, not reporting one, so it settles nothing about this thread.
 *
 * The bot opens almost every first contact with "ini untuk *langganan harian*
 * atau untuk *acara sekali jalan* ya kak?" — and "acara" in its own question
 * was enough to put the thread under EVENT_RULES, where a price stops being
 * general business info. On 2026-09-20 17.02 a lead answered that question with
 * "Langganan harian tp tanpa nasi", and the draft telling her the per-kitchen
 * no-rice discounts was blocked twice over those three prices. She got the
 * fallback template and an escalation, off the back of a question we asked her.
 */
const CONTRASTS_WITH_DAILY = /langganan harian/i;

function settlesEvent(text: string): boolean {
  return mentionsEvent(text) && !CONTRASTS_WITH_DAILY.test(text ?? "");
}

/**
 * The extra rule an event thread gets, appended so the shared prefix above
 * still caches.
 *
 * The validator waives "general business info — menu, prices, policies" because
 * those come from the prompt, which is written from the database and is
 * therefore true. None of that holds for an event: an event is priced by asking
 * the kitchens for a bid, and what goes in the box is whatever that bid covers,
 * so on an event the price and the contents are exactly the claims nobody has
 * verified. On 2026-09-17 the bot told The Breeze her Rp 26.000 boxes included
 * air mineral. No tier includes it; honouring it would have cost Rp 20.000-30.000
 * on 20 boxes and taken the margin from 25% to about 20%. The validator passed
 * the reply, because a claim about what a box contains is "general business
 * info" by the rule above.
 */
const EVENT_RULES = `

This thread is about an event (acara sekali jalan) — a one-off booking, usually one date and boxes for a venue. An event is priced by asking the kitchens for a bid, so for an EVENT the three things below leave the never-flag list above and join the closed list: each one is unsupported unless a CUSTOMER or an ADMIN line in CONVERSATION SO FAR states it.
- any price, rate per porsi, or total for the event
- what the event boxes contain — dishes, drinks, air mineral, buah, kerupuk, packaging
- a delivery date, jam or slot stated as agreed or promised. "Bisa kami usahakan", "kami cek dulu ke dapur" and similar are not claims: never flag those.

File each of those three under the field "event", which exists on this thread in addition to the five above.

The standard daily subscription price list, the daily menu and the delivery areas are still general business info even in this thread. Do not flag those.`;

/**
 * Whether a flag the model raised survives. Three rules, all of them things the
 * model kept getting wrong and code can settle:
 *
 * 1. The field must be one of the five. A flag about a price, the menu or a
 *    kitchen's days has nowhere to be filed, and the model files it anyway —
 *    "Dapur Palem" came back under `name` and "langganan harian tanpa nasi"
 *    under `package_size` on 2026-09-20.
 * 2. A quota or package-size claim must actually quote a number, and that
 *    number must be one CONTEXT does not show. Both of CONTEXT's quota numbers
 *    are correct answers, and the model has rejected the right one for the
 *    other one since Febby on 2026-09-02.
 * 3. An order- or payment-status flag stands only when there is no order at
 *    all. CONTEXT carries neither status, so with an order on file the model is
 *    guessing either way; with none, any "pesanan kakak aktif" is invented.
 */
function keepClaim(
  field: string,
  claim: string,
  activeOrder: ValidateReplyParams["activeOrder"],
  eventThread: boolean,
  teamNames: string[],
): boolean {
  // Only EVENT_RULES offers this field, and only an event thread gets those
  // rules. Listing it in the base prompt gave the model a sixth hook to hang a
  // price on, and it took it on a daily-subscription lead.
  if (field === "event") return eventThread;
  if (field === "name") {
    // A name, not a sentence and not a kitchen. With `name` the only field left
    // that took anything, the model started filing everything under it —
    // "Dapur Palem", a whole price clause, and once the words "Tidak ada nama
    // yang disebut, jadi tidak ada klaim nama."
    // "kak" is what we call everyone, so it is never the claim that we know who
    // they are.
    if (/^(kak|kakak|bapak|ibu|mas|mbak|pak|bu)$/i.test(claim.trim())) {
      return false;
    }
    // `name` is the customer's name. One of our own staff is not a claim about
    // them, and "Jennifer memang bagian dari tim kami" was blocked under it on
    // 2026-09-23 — the very answer the prompt tells the bot to give.
    if (mentionsTeamMember(claim, teamNames)) return false;
    return claim.length <= 40 && !/\d/.test(claim) && !/\bdapur\b/i.test(claim);
  }
  if (field === "quota" || field === "package_size") {
    // "N porsi", which is how the bot states a quota, rather than any digit in
    // the sentence: a claim quoting a menu week came back as `quota` and "21",
    // "26" and "2026" all disagreed with her balance.
    const stated = [...claim.matchAll(/(\d[\d.]*)\s*porsi/gi)].map((m) =>
      Number(m[1].replace(/\./g, "")),
    );
    if (!stated.length) return false;
    if (!activeOrder) return true;
    const known = [
      activeOrder.remainingToday,
      activeOrder.unbooked,
      activeOrder.packageSize,
    ];
    return stated.some((n) => !known.includes(n));
  }
  if (field === "order_status" || field === "payment_status") {
    // The claim has to assert a state, not merely mention an order. "Langganan
    // harian tanpa nasi bisa kami layani" — an answer about what we sell — came
    // back filed as this customer's order status.
    const asserts =
      field === "order_status"
        ? /\b(aktif|berjalan|jalan|selesai|dibatalkan|batal|dijeda|jeda|tercatat|diproses|berlangsung)\b/i
        : /\b(sudah|belum|lunas|terbayar|diterima|masuk|terkonfirmasi)\b/i;
    return !activeOrder && asserts.test(claim);
  }
  return false;
}

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
  }
Delivery dates already booked: ${
    params.upcoming?.length
      ? params.upcoming
          .map((d) => `${d.date} ${d.mealType} ${d.portions} porsi`)
          .join("; ")
      : "none on the calendar"
  }`;

  const transcript = (params.transcript ?? [])
    .map((m) => {
      if (m.role !== "assistant") return `CUSTOMER: ${m.content}`;
      return `${m.sentBy ? "ADMIN" : "BOT"}: ${m.content}`;
    })
    .join("\n");

  // What makes this an event thread is the customer asking for one, or the bot
  // answering as though they had. A BOT line counts here and nowhere else: it
  // decides which rules the reply is checked against, never whether a claim is
  // true.
  const eventThread =
    settlesEvent(params.reply) ||
    (params.transcript ?? []).some((m) => settlesEvent(m.content));

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
      system: eventThread ? VALIDATOR_SYSTEM + EVENT_RULES : VALIDATOR_SYSTEM,
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
      unsupported_claims?: (string | { field?: string; claim?: string })[];
    };
    if (parsed.valid !== false) return { valid: true, unsupportedClaims: [] };

    // The filter, and the half of the fix that does not depend on the model
    // taking an instruction. A flag survives only if it names one of the six
    // fields; a bare string names none, which is what the model returns when it
    // has flagged something it could not file. Both are dropped, and a draft
    // left with nothing against it is valid.
    const { names: teamNames } = parseTeamRoster(
      await getSetting("team_roster"),
    );
    const dropped: string[] = [];
    const kept: string[] = [];
    for (const raw of parsed.unsupported_claims ?? []) {
      const field = typeof raw === "string" ? "" : (raw.field ?? "").trim();
      const claim =
        typeof raw === "string" ? raw : (raw.claim ?? raw.field ?? "").trim();
      if (keepClaim(field, claim, params.activeOrder, eventThread, teamNames)) {
        kept.push(`${field}: ${claim}`);
      } else {
        dropped.push(`${field || "(no field)"}: ${claim}`);
      }
    }
    // Logged rather than silent: if the model ever stops naming fields this is
    // the line that says the checker has quietly become a no-op.
    if (dropped.length) {
      console.warn("[validate-reply] dropped off-scope claims:", dropped);
    }
    return { valid: kept.length === 0, unsupportedClaims: kept };
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
