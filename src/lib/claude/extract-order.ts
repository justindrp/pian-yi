import type Anthropic from "@anthropic-ai/sdk";
import { logEdit, systemActor } from "@/lib/audit/log-edit";
import { getSetting } from "@/lib/cache/settings";
import { classifyAddress } from "@/lib/claude/classify-address";
import {
  getAnthropicClient,
  modelTag,
  NO_THINKING,
  SONNET_MODEL,
} from "@/lib/claude/client";
import {
  loadHistory,
  saveMessage,
  updateMessageReceipt,
} from "@/lib/claude/conversation";
import { isDeliveryDay } from "@/lib/holidays/id";
import { stripCompensation } from "@/lib/kitchen/compensation";
import {
  normalizeSize,
  type OrderSize,
  sizeMSurcharge,
} from "@/lib/orders/size";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { activeDeliveryAreas } from "@/lib/subcontractors/areas";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDeliveryRoute } from "@/lib/utils/format";
import { normalizePhone, samePhone } from "@/lib/utils/phone";
import { sendTextMessage } from "@/lib/whatsapp/client";
import { demoDisplayName, isDemoPhone } from "@/lib/whatsapp/demo";
import { WINDOW_NOTICE_SHORT } from "@/lib/whatsapp/window-notice";

export interface DeliveryScheduleSlot {
  date: string;
  meal_type: string;
  portions: number;
}

export interface ExtractedOrderInput {
  customer_name: string;
  beneficiary_name?: string;
  beneficiary_phone?: string;
  package_size: number;
  portions_per_delivery: number;
  portions_lunch?: number;
  portions_dinner?: number;
  address: string;
  maps_link: string;
  area: string;
  sub_area?: string;
  address_2?: string;
  maps_link_2?: string;
  area_2?: string;
  sub_area_2?: string;
  address_2_meal?: string;
  custom_schedule?: Record<string, unknown>;
  /**
   * Every delivery day the customer named. Required, and `[]` is the answer for
   * a customer who books day by day — see the tool description.
   */
  delivery_schedule?: DeliveryScheduleSlot[];
  start_date?: string;
  end_date?: string;
  subcontractor_id?: string;
  size?: string;
  nasi_merah?: boolean;
  catatan?: string;
}

export interface ExtractedOrderPricing {
  price_per_portion: number;
  total_price: number;
}

export type ExtractedOrderReview = ExtractedOrderInput & ExtractedOrderPricing;
const LEARNED_CONTEXT_START = "[AI learned context]";
const LEARNED_CONTEXT_END = "[/AI learned context]";

/**
 * Merge an accepted custom request into `customers.notes` as a manual note.
 *
 * The kitchen sheet (`/dapur/[id]`) prints `manualNotesOnly()` — everything
 * before the [AI learned context] block — and only falls back to that block's
 * `Preferensi:` bullets when there is no manual note at all. Writing here is
 * therefore the one path that does not depend on the summarizer having noticed
 * the request in the chat: on 2026-08-25 Surya's "tanpa nasi" reached the
 * kitchen only because someone typed it into this column by hand.
 *
 * The note goes above any existing manual text and always above the AI block,
 * because that block must stay last for `manualNotesOnly()` to keep cutting it
 * off — the sheet is unauthenticated and the block carries prices.
 *
 * Returns null when there is nothing to change, so the caller leaves the column
 * alone instead of rewriting it on every amendment.
 */
export function mergeKitchenNote(
  existing: string | null,
  note: string,
): string | null {
  // The model carries "(protein +25%)" across from the sentence it says to the
  // customer. That is our arrangement with the kitchen, not the customer's
  // request — see `stripCompensation`.
  const clean = stripCompensation(note.trim());
  if (!clean) return null;

  const notes = existing ?? "";
  const aiAt = notes.indexOf(LEARNED_CONTEXT_START);
  const manual = (aiAt === -1 ? notes : notes.slice(0, aiAt)).trim();
  const aiBlock = aiAt === -1 ? "" : notes.slice(aiAt).trim();

  // extract_order runs again on every amendment and every renewal, so an
  // unconditional prepend would stack the same line up the sheet until it
  // pushed the drop-off instructions out of sight.
  if (manual.toLowerCase().includes(clean.toLowerCase())) return null;

  const merged = manual ? `${clean}\n${manual}` : clean;
  return aiBlock ? `${merged}\n\n${aiBlock}` : merged;
}

// One shared property schema. The webhook used to carry its own copy and it had
// drifted: `delivery_schedule` was missing there entirely, so the live bot could
// never book a customer's named dates at order creation — only a start/end range
// it then filled in by weekday. Cindy Angelia's 11, 12, 13, 14, 18 Agustus is
// exactly the shape that loses (11–18 by weekday is a different set of days).
const EXTRACT_ORDER_PROPERTIES_BASE = {
  customer_name: { type: "string" },
  beneficiary_name: {
    type: "string",
    description:
      "Only when this package is for someone other than the person chatting — a friend, a partner, a child, a colleague — and is delivered to them, not to the buyer. The name of the person who will eat the food. Leave both beneficiary fields out for an ordinary order, including one the customer sends to their own second address.",
  },
  beneficiary_phone: {
    type: "string",
    description:
      "The WhatsApp number of the person named in beneficiary_name, as they wrote it (08xx, 62xx or +62xx all fine). Required whenever beneficiary_name is given: it is what tells their package apart from the buyer's. Ask for it before calling this tool, and if the buyer does not have it, do not call this tool for the second package at all — escalate instead.",
  },
  package_size: {
    type: "number",
    description:
      "Total portions in the package/order, not the number of delivery days. Example: 2 portions per delivery for 5 delivery days means package_size = 10.",
  },
  portions_per_delivery: {
    type: "number",
    description: "How many portions are sent on each delivery day.",
  },
  portions_lunch: { type: "number" },
  portions_dinner: { type: "number" },
  address: { type: "string" },
  maps_link: {
    type: "string",
    description: "Google Maps link provided by the customer",
  },
  sub_area: {
    type: "string",
    description:
      "Sub-location within the area: district name for houses, apartment name for apartments, building name for offices",
  },
  address_2: {
    type: "string",
    description:
      "Second delivery address, when one of the two meals goes somewhere else every day — makan siang ke kampus/kantor, makan malam ke kost. Leave it out when both meals go to the same place, and never use it for a one-off change of address on a single day.",
  },
  maps_link_2: {
    type: "string",
    description: "Google Maps link for address_2",
  },
  sub_area_2: {
    type: "string",
    description: "Sub-location within area_2, same rule as sub_area",
  },
  address_2_meal: {
    type: "string",
    enum: ["lunch", "dinner"],
    description:
      "Which meal is delivered to address_2 every day. Required whenever address_2 is given — without it the second address is stored but never delivered to.",
  },
  custom_schedule: { type: "object" },
  start_date: {
    type: "string",
    description: "ISO date string YYYY-MM-DD",
  },
  end_date: {
    type: "string",
    description:
      "ISO date string YYYY-MM-DD — the customer's requested last delivery date",
  },
  delivery_schedule: {
    type: "array",
    description:
      'REQUIRED. Every delivery day the customer named, one entry per day per meal — a plain Senin–Jumat run and a set with gaps (11, 12, 13, 14, 18) are both written out in full. Send `[]`, an empty array, when the customer books day by day ("bebas", "saya pesan harian", "nanti saya kabari") — that is a real answer and it sells them the quota with no dates attached. Never leave the field out: if you do not yet know which days they want, ask them before calling this tool at all. package_size must equal the sum of all slot portions.',
    items: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "ISO date YYYY-MM-DD",
        },
        meal_type: {
          type: "string",
          enum: ["lunch", "dinner"],
        },
        portions: { type: "number" },
      },
      required: ["date", "meal_type", "portions"],
    },
  },
  subcontractor_id: {
    type: "string",
    description: "UUID of the chosen dapur, from the dapur list given",
  },
  size: {
    type: "string",
    enum: ["s", "m"],
    description:
      '"m" only when the customer chose size M from a dapur that offers it, and only after they were told the M price. Otherwise "s". An M order for a dapur that does not cook M is written as S.',
  },
  nasi_merah: {
    type: "boolean",
    description:
      "True when the customer asked for nasi merah. Adds Rp 5.000 per portion to the price and records the same amount as what the kitchen charges us.",
  },
  catatan: {
    type: "string",
    description:
      "The accepted custom requests for this order, written the way the kitchen needs to read them: 'tanpa nasi', 'tidak pedas', 'tidak ada daging sapi', 'tidak ada seafood'. Comma-separate more than one. Write only what the customer asked for, never what we do about it internally — 'tanpa nasi', never 'tanpa nasi (protein +25%)'. The protein increase is our arrangement with the kitchen and must not appear here. This text is printed on the kitchen's delivery sheet, so leave it empty unless the customer actually asked for something, and never put prices, totals, addresses or internal notes in it. Do not use it for nasi merah — that has its own field because it changes the price.",
  },
} as const;

/**
 * The extract_order properties, with `area` constrained to the areas the active
 * kitchens actually cover. Pass `activeDeliveryAreas(db)`.
 *
 * The enum used to be a literal five-name array in this file and a second,
 * separately-drifting copy in the simulator. An area added to a kitchen would
 * have been unrepresentable in the tool call, so the model would have had to
 * pick a wrong one or omit a required field.
 */
export function extractOrderProperties(areas: string[]) {
  return {
    ...EXTRACT_ORDER_PROPERTIES_BASE,
    area: { type: "string", enum: areas },
    area_2: { type: "string", enum: areas },
  };
}

/**
 * Words the model sends in `customer_name` when the customer never gave one.
 * `customer_name` is a required field of extract_order, so the model must put
 * something there, and the system prompt used to instruct it to put the literal
 * "Kak" — which was stored and then read back out by every greeting, so
 * +6285692715738 was addressed as "Halo kak Kak!" on 2026-08-26 and their
 * order, inbox thread and delivery label all carried "Kak" as the name. The
 * prompt now asks for an empty string, but the prompt is a request and this is
 * the guard: an honorific is not a name no matter which field it arrives in.
 */
const PLACEHOLDER_NAMES = new Set([
  "kak",
  "kakak",
  "kk",
  "ka",
  "unknown",
  "tidak diketahui",
  "belum diketahui",
  "customer",
  "pelanggan",
  "-",
]);

export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_NAMES.has(
    name
      .trim()
      .toLowerCase()
      .replace(/[.,!]+$/, ""),
  );
}

/**
 * Whether a name the customer just gave should be written to their record.
 * Only ever fills a name that is missing: the model's is whatever signature it
 * read off the chat, and Julian S was renamed to "Julian" by an order he never
 * placed. Shared by extract_order and the webhook's record_customer_name so the
 * two cannot drift.
 */
export function shouldRecordName(
  given: string | null | undefined,
  existing: string | null | undefined,
): boolean {
  const name = (given ?? "").trim();
  return !!name && !isPlaceholderName(name) && !(existing ?? "").trim();
}

export function extractOrderTool(areas: string[]): Anthropic.Messages.Tool {
  return {
    name: "extract_order",
    description:
      "Extracts all order details the customer has already provided earlier in this conversation.",
    input_schema: {
      type: "object",
      properties: extractOrderProperties(areas),
      required: [
        "customer_name",
        "package_size",
        "portions_per_delivery",
        "address",
        "area",
        "delivery_schedule",
      ],
    },
  };
}

/**
 * Re-runs order extraction against a customer's existing conversation history —
 * for admin use when the bot got stuck/rate-limited before calling extract_order itself.
 * Does not write to the DB; caller reviews/edits the result before confirming.
 */
export async function extractOrderFromConversation(
  customerId: string,
  options?: { since?: string },
): Promise<ExtractedOrderInput | null> {
  const history = trimTrailingAssistantMessages(
    await loadHistory(customerId, 60, options?.since),
  );
  if (history.length === 0) return null;

  const db = createAdminClient();
  const { data: customer } = await db
    .from("customers")
    .select("notes, address, area, sub_area")
    .eq("id", customerId)
    .single();
  const { data: activeSubs } = await db
    .from("subcontractors")
    .select("id, customer_nickname")
    .eq("is_active", true)
    .not("customer_nickname", "is", null);
  const servedAreas = await activeDeliveryAreas(db);
  const dapurList = (activeSubs ?? [])
    .map((s) => `- ${s.customer_nickname}: ${s.id}`)
    .join("\n");

  const today = new Date().toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const learnedContext = extractLearnedContext(customer?.notes ?? null);

  const system = `You are reviewing a WhatsApp conversation between a catering customer and our ordering bot. The customer has already provided their order details somewhere in this conversation. Call extract_order with every field you can determine from the conversation. Today is ${today} — resolve any relative dates the customer mentioned against that. Leave a field out only if the customer genuinely never provided it.

Important: package_size must be the total number of portions in the full order, not the number of delivery days. For example, 2 portions per delivery for 5 delivery days means package_size = 10.

Saved customer context from prior learning (may help disambiguate location, preferences, or already-confirmed details; chat messages still take priority if they conflict):
${learnedContext || "none"}

Available dapur (kitchen) IDs:
${dapurList || "none"}`;

  const anthropic = getAnthropicClient();
  let response: Anthropic.Messages.Message;
  try {
    response = await anthropic.messages.create({
      model: SONNET_MODEL,
      ...NO_THINKING,
      max_tokens: 1024,
      system,
      messages: history,
      tools: [extractOrderTool(servedAreas)],
      tool_choice: { type: "tool", name: "extract_order" },
    });
  } catch (err) {
    console.error("extractOrderFromConversation: Anthropic call failed", err);
    return null;
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock =>
      block.type === "tool_use",
  );
  if (!toolUse) return null;

  return normalizeExtractedOrder(
    withRecordedAddress(toolUse.input as ExtractedOrderInput, customer),
    history,
    learnedContext,
  );
}

// A returning customer never retypes their address — it is on their record, and
// the bot is told not to ask for it again. Extraction reads the chat alone, so it
// comes back with no address for exactly those customers, and both webhook
// recovery paths gate on having one: Febby was quoted 30 porsi at Rp 810.000 on
// 2026-08-18, the bot said "saya catat nambah 30 porsi", and the recovery that
// should have created it declined because the chat held no address. Fall back to
// what we already have on file rather than treat a known customer as addressless.
function withRecordedAddress(
  input: ExtractedOrderInput,
  customer: {
    address?: string | null;
    area?: string | null;
    sub_area?: string | null;
  } | null,
): ExtractedOrderInput {
  if (input.address?.trim()) return input;
  const recorded = customer?.address?.trim();
  if (!recorded) return input;
  return {
    ...input,
    address: recorded,
    area: input.area?.trim() || (customer?.area ?? ""),
    sub_area: input.sub_area ?? customer?.sub_area ?? undefined,
  };
}

/**
 * The customer's last word on how many portions they want beats the size the
 * model passed to extract_order. DeepSeek carries a number agreed earlier in the
 * chat straight through a correction: on 2026-08-19 Tiwi was quoted 5 porsi, then
 * 8, then wrote "Boleh 6 porsi dulu kak" with her address, and the tool fired with
 * 5 — she was sent a bill for Rp 145.000 and told "6 porsi = Rp 174.000" in the
 * next message. Only the final customer message is read, and only a bare total:
 * "1 porsi per pengiriman" and "2 porsi/hari" describe a delivery, not an order.
 *
 * Webhook paths only. The admin inbox runs the same extraction, but there a human
 * has already read the size in the review modal, and their number must win.
 */
/** Beyond this a "N porsi" match is a misread number, not an order. */
const LARGEST_PLAUSIBLE_SIZE = 500;

/**
 * The one bare portion total a message states, or null when it states none or
 * more than one. "1 porsi per pengiriman" describes a delivery, not an order,
 * and a thousands separator or preceding digit means we are reading the tail of
 * a price — a replay pulled "15330" out of a message that way.
 *
 * The number and the word must sit on the same line, the number must not be
 * glued to a word, and "Porsi:" as a form label never counts. PT Bintang's
 * filled order form ends one line in a maps link (…WhZA3f6) and starts the next
 * with "Porsi: 22 box"; the old `\s*` crossed the newline, read the URL's
 * trailing 6 as a total, and amended their 110-porsi order down to 6.
 */
export function statedBareTotal(text: string): number | null {
  const sizes = new Set<number>();
  for (const match of text.matchAll(
    /(?<![\w.,])(\d+)[ \t]*porsi\b(?!\s*:)(?!\s*(?:\/|per\s)?\s*(?:hari|pengiriman|kali|x\b))/gi,
  )) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0 && n <= LARGEST_PLAUSIBLE_SIZE)
      sizes.add(n);
  }
  return sizes.size === 1 ? ([...sizes][0] as number) : null;
}

/**
 * The rupiah figure a transfer receipt states, or null. Gated on the message
 * looking like a receipt at all — a price the bot quoted back is not money that
 * moved. Kurniadi Tan pasted "m-Transfer: BERHASIL ... Rp 540.000,00" on
 * 2026-08-04 and got an order for Rp 280.000.
 */
export function statedTransferAmount(text: string): number | null {
  if (!/(m-?transfer|berhasil|sudah\s*(tf|transfer)|transfer)/i.test(text)) {
    return null;
  }
  const amounts = new Set<number>();
  for (const match of text.matchAll(/(?:rp\.?\s*)?(\d{1,3}(?:\.\d{3})+)/gi)) {
    const n = Number(match[1].replace(/\./g, ""));
    if (Number.isFinite(n) && n >= 50_000) amounts.add(n);
  }
  return amounts.size === 1 ? ([...amounts][0] as number) : null;
}

/** How many weeks the customer said the package should run, or null. */
export function statedWeeks(text: string): number | null {
  const weeks = new Set<number>();
  for (const match of text.matchAll(/(?<![\d.,])(\d+)\s*minggu/gi)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0 && n <= 52) weeks.add(n);
  }
  return weeks.size === 1 ? ([...weeks][0] as number) : null;
}

/** The customer's own messages, newest last, as one string per message. */
async function customerMessages(
  customerId: string,
  limit = 30,
): Promise<string[]> {
  const db = createAdminClient();
  const { data } = await db
    .from("conversations")
    .select("content")
    .eq("customer_id", customerId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((row) => row.content ?? "").filter(Boolean);
}

/**
 * The package size whose total equals what the customer actually transferred.
 * Money that has moved outranks every number in the conversation, including the
 * bot's own arithmetic: Kurniadi Tan paid Rp 540.000 and the order was written
 * for 10 porsi at Rp 280.000, because the bot calls a 10-day lunch+dinner
 * package "paket 10 porsi".
 */
async function packageSizeMatchingPayment(
  customerId: string,
  nasiMerah: boolean,
): Promise<number | null> {
  const messages = await customerMessages(customerId, 10);
  const amounts = messages
    .map(statedTransferAmount)
    .filter((n): n is number => n !== null);
  if (amounts.length === 0) return null;
  const paid = amounts[0] as number;

  // A corporate customer's total is paid / rate, not a tier lookup — the ladder
  // never produces their price, so walking it would always miss. A DP that does
  // not divide evenly tells us nothing about the size, so say nothing.
  const contract = await contractPrice(customerId);
  if (contract !== null) {
    const rate = contract + (nasiMerah ? NASI_MERAH_SURCHARGE : 0);
    return rate > 0 && paid % rate === 0 ? paid / rate : null;
  }

  const db = createAdminClient();
  const { data: tiers } = await db
    .from("pricing_tiers")
    .select("portions")
    .order("portions", { ascending: true });
  for (const tier of tiers ?? []) {
    const { total_price } = await getExtractedOrderPricing(
      tier.portions,
      nasiMerah,
    );
    if (total_price === paid) return tier.portions;
  }
  return null;
}

export async function applyLatestCustomerSize(
  customerId: string,
  input: ExtractedOrderInput,
): Promise<ExtractedOrderInput> {
  // A size the model dropped entirely used to be floored to the smallest tier we
  // sell, which creates a real order for the wrong package — and that order then
  // blocks the promise recovery that would have built the right one. Nadya agreed
  // to 20 porsi at Rp 540.000 on 2026-08-18, the tool fired with no size, and she
  // was billed Rp 145.000 for 5. Re-read the chat with the forced-tool extraction
  // instead; the floor stays as the last resort inside createOrderFromExtraction.
  if (!input.package_size || input.package_size <= 0) {
    const reread = await extractOrderFromConversation(customerId);
    if (reread?.package_size && reread.package_size > 0) {
      console.log(
        `[extract-order] package_size recovered as ${reread.package_size} by re-reading the conversation`,
      );
      input = { ...input, package_size: reread.package_size };
    }
  }

  const db = createAdminClient();
  const { data: last } = await db
    .from("conversations")
    .select("content")
    .eq("customer_id", customerId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const text = last?.content;
  if (!text) return input;

  // The number has to stand alone: a thousands separator or a preceding digit
  // means we are reading the tail of a price, not a portion count. A replay on
  // 2026-08-19 pulled "15330" out of a message this way and would have created
  // a Rp 400 juta order. The upper bound is the same guard from the other end —
  // the largest tier we sell is 144, so anything past LARGEST_PLAUSIBLE_SIZE is
  // a misread rather than an order.
  const stated = statedBareTotal(text);
  if (stated === null) return input;
  if (stated === input.package_size) return input;
  if (stated < (await minPackageSize())) return input;

  console.log(
    `[extract-order] package_size ${input.package_size} -> ${stated} from the customer's last message`,
  );
  return { ...input, package_size: stated };
}

// Nasi merah is the one add-on we sell, and we charge it through at cost: the
// customer pays the tier price plus this, and the kitchen bills us the same
// amount on top of the route rate (`orders.addon_cost_per_portion`).
export const NASI_MERAH_SURCHARGE = 5000;

/**
 * The smallest package we sell, read from pricing_tiers. Used to floor a size the
 * model got wrong or dropped: DeepSeek omitted package_size entirely on two
 * 2026-08-19 replays (NOT NULL violation, no order at all) and returned 3 on a
 * third, for a customer who had agreed to 5.
 */
export async function minPackageSize(): Promise<number> {
  const db = createAdminClient();
  const { data } = await db
    .from("pricing_tiers")
    .select("portions")
    .order("portions", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.portions ?? 5;
}

/**
 * A corporate customer's negotiated rate, or null for ordinary tier pricing.
 * Kept separate from getExtractedOrderPricing so the size-validation paths can
 * ask the same question without pricing anything.
 */
export async function contractPrice(
  customerId: string | null | undefined,
): Promise<number | null> {
  if (!customerId) return null;
  const db = createAdminClient();
  const { data } = await db
    .from("customers")
    .select("contract_price_per_portion")
    .eq("id", customerId)
    .maybeSingle();
  const price = data?.contract_price_per_portion ?? null;
  return typeof price === "number" && price > 0 ? price : null;
}

export async function getExtractedOrderPricing(
  packageSize: number,
  nasiMerah = false,
  customerId?: string | null,
  portionSize: OrderSize = "s",
): Promise<ExtractedOrderPricing> {
  // M is folded into price_per_portion rather than carried beside it, so the
  // rate an order locks at creation is the rate the customer agreed to and
  // every downstream reader — total_price, the ledger, accounting — keeps
  // working without learning about sizes.
  const sizeExtra = portionSize === "m" ? await sizeMSurcharge() : 0;

  // A negotiated rate replaces the ladder outright. PT Bintang Lautan buys 110
  // porsi at Rp 35.000 — above every tier — so tier lookup can only ever get
  // their order wrong. Add-ons still stack: what the kitchen charges extra is
  // charged through at cost regardless of who the customer is.
  const contract = await contractPrice(customerId);
  if (contract !== null) {
    const pricePerPortion =
      contract + (nasiMerah ? NASI_MERAH_SURCHARGE : 0) + sizeExtra;
    return {
      price_per_portion: pricePerPortion,
      total_price: pricePerPortion * packageSize,
    };
  }

  const db = createAdminClient();
  const { data: tier } = await db
    .from("pricing_tiers")
    .select("price_per_portion")
    .lte("portions", packageSize)
    .order("portions", { ascending: false })
    .limit(1)
    .maybeSingle();

  // A size below the smallest tier matches no row, and the price then came out
  // Rp 0 — an order the kitchen cooks for free. Dewi's 2026-08-03 order was
  // written that way (package 3, price 0). Fall back to the cheapest tier we
  // publish; a price an admin adjusts beats a price of nothing.
  const { data: smallestTier } = tier
    ? { data: null }
    : await db
        .from("pricing_tiers")
        .select("price_per_portion")
        .order("portions", { ascending: true })
        .limit(1)
        .maybeSingle();

  const basePrice =
    tier?.price_per_portion ?? smallestTier?.price_per_portion ?? 0;
  const pricePerPortion =
    basePrice + (nasiMerah ? NASI_MERAH_SURCHARGE : 0) + sizeExtra;
  return {
    price_per_portion: pricePerPortion,
    total_price: pricePerPortion * packageSize,
  };
}

function extractLearnedContext(notes: string | null): string | null {
  if (!notes) return null;
  const start = notes.indexOf(LEARNED_CONTEXT_START);
  const end = notes.indexOf(LEARNED_CONTEXT_END);
  if (start === -1 || end === -1 || end <= start) return null;
  const content = notes.slice(start + LEARNED_CONTEXT_START.length, end).trim();
  return content || null;
}

function trimTrailingAssistantMessages(
  history: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  let end = history.length;
  while (end > 0 && history[end - 1]?.role === "assistant") {
    end -= 1;
  }
  return history.slice(0, end);
}

function normalizeExtractedOrder(
  input: ExtractedOrderInput,
  history: Anthropic.Messages.MessageParam[],
  learnedContext: string | null,
): ExtractedOrderInput {
  const inferredPackageSize = inferPackageSizeFromContext(
    history,
    learnedContext,
    input,
  );
  if (
    inferredPackageSize !== null &&
    inferredPackageSize !== input.package_size
  ) {
    return { ...input, package_size: inferredPackageSize };
  }

  const portionsPerDelivery = getPortionsPerDelivery(input);
  if (
    input.package_size > 0 &&
    portionsPerDelivery > 1 &&
    input.package_size % portionsPerDelivery !== 0
  ) {
    return {
      ...input,
      package_size: input.package_size * portionsPerDelivery,
    };
  }

  return input;
}

function inferPackageSizeFromContext(
  history: Anthropic.Messages.MessageParam[],
  learnedContext: string | null,
  input: ExtractedOrderInput,
): number | null {
  const text = [
    learnedContext ?? "",
    ...history.map((message) =>
      typeof message.content === "string" ? message.content : "",
    ),
  ].join("\n");

  const explicitTotalPattern =
    /(\d+)\s*porsi\s*x\s*(\d+)\s*hari\s*=\s*(\d+)\s*porsi/gi;
  for (const match of text.matchAll(explicitTotalPattern)) {
    const perDelivery = Number(match[1]);
    const total = Number(match[3]);
    if (Number.isFinite(total) && total > 0) {
      if (
        !input.portions_per_delivery ||
        input.portions_per_delivery === perDelivery
      ) {
        return total;
      }
    }
  }

  const totalOnlyPattern = /total(?: tetap)?\s*(\d+)\s*porsi/gi;
  for (const match of text.matchAll(totalOnlyPattern)) {
    const total = Number(match[1]);
    if (Number.isFinite(total) && total > 0) return total;
  }

  const dailyPattern =
    /(\d+)\s*porsi(?:\/hari| per hari|\/pengiriman| per pengiriman).{0,40}?(\d+)\s*hari/gi;
  for (const match of text.matchAll(dailyPattern)) {
    const perDelivery = Number(match[1]);
    const dayCount = Number(match[2]);
    const total = perDelivery * dayCount;
    if (
      Number.isFinite(total) &&
      total > 0 &&
      (!input.portions_per_delivery ||
        input.portions_per_delivery === perDelivery)
    ) {
      return total;
    }
  }

  return null;
}

function getPortionsPerDelivery(input: ExtractedOrderInput): number {
  const lunch = input.portions_lunch ?? 0;
  const dinner = input.portions_dinner ?? 0;
  const combined = lunch + dinner;
  return combined > 0 ? combined : input.portions_per_delivery;
}

/**
 * Same DB writes + payment-details WhatsApp message as the bot's own extract_order
 * tool handler — shared so the admin-triggered path and the live bot path can't drift apart.
 */
/**
 * The next date we deliver on, starting tomorrow: Senin–Sabtu, skipping libur
 * nasional. Used only as a fallback when the conversation fixed no start date.
 */
function nextDeliveryDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  for (let i = 0; i < 14; i++) {
    const ymd = d.toISOString().slice(0, 10);
    if (isDeliveryDay(ymd)) return ymd;
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * A customer who changes the size before paying is amending the order, not
 * placing a second one. Tiwi asked for "Total 8 porsi" on 2026-08-03, got the
 * transfer details, then wrote "Boleh 6 porsi dulu kak" — the order stayed at 8
 * and she was left holding a bill for a package she had just reduced. Only a
 * pending_payment order is amendable: once a proof is in, the money has moved
 * and the change is an admin decision.
 *
 * Returns whether an order was resized.
 */
/** A customer asking for nasi merah, which carries a per-portion surcharge. */
const NASI_MERAH_REQUEST = /nasi\s*merah/i;

/**
 * A message that looks like it names delivery days — two or more dates, or one
 * date carrying a month name. The gate is cheap on purpose: filling a schedule
 * costs a forced-tool extraction, so it must not run on every inbound message.
 */
const DATE_LIST =
  /(?<![\d.,])\d{1,2}\s*(jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des)|(?<![\d.,])\d{1,2}\s*[,/-]\s*\d{1,2}\s*[,/-]\s*\d{1,2}/i;

/**
 * An order created before the customer sent their days carries no schedule, and
 * nothing else ever fills one: Cindy Angelia confirmed 5 porsi at turn 3 and
 * sent the form naming 11, 12, 13, 14 and 18 Agustus afterwards, so her order
 * sat empty. Re-read the conversation and fill it while the order is still
 * unpaid. Non-contiguous days are why this cannot be derived — only the
 * customer's own list has them.
 *
 * This writes orders.requested_schedule, not delivery rows. The rows are
 * mark_paid's job.
 */
async function fillMissingSchedule(
  customerId: string,
  orderId: string,
): Promise<void> {
  const db = createAdminClient();
  const { data: order } = await db
    .from("orders")
    .select("package_size, requested_schedule")
    .eq("id", orderId)
    .maybeSingle();
  // Only ever fill an empty one. A schedule already here is the one the
  // customer asked for and a second extraction can only degrade it.
  if (!order || order.requested_schedule) return;

  const extracted = await extractOrderFromConversation(customerId);
  const schedule = extracted?.delivery_schedule?.length
    ? [...extracted.delivery_schedule].sort((a, b) =>
        a.date.localeCompare(b.date),
      )
    : null;
  if (!schedule) return;

  // Never record more days than the package covers.
  const budget = order.package_size ?? 0;
  const slots: { date: string; meal_type: string; portions: number }[] = [];
  let used = 0;
  for (const slot of schedule) {
    if (used + slot.portions > budget) break;
    used += slot.portions;
    slots.push({
      date: slot.date,
      meal_type: slot.meal_type,
      portions: slot.portions,
    });
  }
  if (!slots.length) return;

  const { error } = await db
    .from("orders")
    .update({
      requested_schedule: slots as import("@/types/database").Json,
      start_date: slots[0].date,
      end_date: slots[slots.length - 1].date,
    })
    .eq("id", orderId);
  if (error) {
    console.error("[extract-order] schedule backfill failed:", error.message);
    return;
  }
  console.log(
    `[extract-order] backfilled ${slots.length} scheduled days onto order ${orderId}`,
  );
}

export async function resizePendingOrderFromMessage(
  customerId: string,
  phone: string,
  text: string,
): Promise<boolean> {
  const rawStated = statedBareTotal(text);
  const stated =
    rawStated !== null && rawStated >= (await minPackageSize())
      ? rawStated
      : null;
  const wantsNasiMerah = NASI_MERAH_REQUEST.test(text);
  const listsDates = DATE_LIST.test(text);
  if (stated === null && !wantsNasiMerah && !listsDates) return false;

  const db = createAdminClient();
  const { data: order } = await db
    .from("orders")
    .select("id, package_size, addon_cost_per_portion, size")
    .eq("customer_id", customerId)
    .eq("status", "pending_payment")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!order) return false;

  // Dates alone amend nothing about the money, so they never reach the
  // re-pricing below or send the customer a second nominal — they only fill a
  // schedule the order does not have yet.
  if (stated === null && !wantsNasiMerah) {
    await fillMissingSchedule(customerId, order.id);
    return false;
  }

  const size = stated ?? order.package_size;
  // The add-on is charged through at cost and already sits inside
  // price_per_portion, so re-price with it rather than dropping it. A customer
  // who asks for nasi merah after the order exists is amending it the same way
  // a size change is: Cindy Angelia's 5-porsi order was created before she sent
  // the form asking for it, and stayed at Rp 145.000 against a real Rp 170.000.
  const nasiMerah = wantsNasiMerah || (order.addon_cost_per_portion ?? 0) > 0;
  const addingAddon = nasiMerah && (order.addon_cost_per_portion ?? 0) === 0;
  if (size === order.package_size && !addingAddon) return false;

  // The S/M size is the order's, never re-read from this message. It is folded
  // into price_per_portion, so re-pricing without it would quietly demote an M
  // order to S rates the moment the customer changed the portion count — the
  // same way dropping the add-on would. Changing size is not something a bare
  // number in a chat message can express, and nothing here tries to read one.
  const portionSize = normalizeSize(order.size);

  const { price_per_portion: pricePerPortion, total_price: totalPrice } =
    await getExtractedOrderPricing(size, nasiMerah, customerId, portionSize);

  const { error } = await db
    .from("orders")
    .update({
      package_size: size,
      price_per_portion: pricePerPortion,
      total_price: totalPrice,
      ...(nasiMerah ? { addon_cost_per_portion: NASI_MERAH_SURCHARGE } : {}),
    })
    .eq("id", order.id);
  if (error) {
    console.error(
      "[extract-order] pending order resize failed:",
      error.message,
    );
    return false;
  }

  await fillMissingSchedule(customerId, order.id);

  const [bankName, bankAccountNumber, bankAccountName] = await Promise.all([
    getSetting("bank_name"),
    getSetting("bank_account_number"),
    getSetting("bank_account_name"),
  ]);
  const msg = `Baik kak, pesanannya kami ubah jadi ${size} porsi${addingAddon ? " dengan nasi merah" : ""} ya 😊\n\n💰 Nominal baru: Rp ${totalPrice.toLocaleString("id-ID")}\n🏦 ${bankName}: ${bankAccountNumber}\n👤 a.n. ${bankAccountName}\n\nSetelah transfer, mohon kirim bukti pembayaran ya kak 🙏`;
  const conversationId = await saveMessage({
    customerId,
    role: "assistant",
    content: msg,
    modelUsed: modelTag("sonnet"),
  });
  const whatsappMessageId = await sendTextMessage(phone, msg);
  await updateMessageReceipt({
    conversationId,
    whatsappMessageId,
    status: "sent",
  });
  console.log(
    `[extract-order] pending order ${order.id} amended ${order.package_size} -> ${size}${addingAddon ? " + nasi merah" : ""}`,
  );
  return true;
}

/**
 * Who the package being extracted actually belongs to.
 *
 * `self` is nearly every order. `third_party` is a customer buying for someone
 * else who eats somewhere else — Naya's friend Cila, Maria Marcella extending
 * Fiana's package. `ask` is the same case with nobody identifiable at the other
 * end, which is a question for the buyer, not a guess for us to make.
 */
type BeneficiaryTarget =
  | { kind: "self" }
  | { kind: "ask"; missing: "phone" | "name"; message: string }
  | {
      kind: "third_party";
      customerId: string;
      name: string;
      phone: string;
      created: boolean;
    };

/**
 * Resolve `beneficiary_phone` to the customer record the order belongs on.
 *
 * A package bought for a third party had nowhere to land. The order could only
 * go on the buyer, so the food was scheduled against the buyer's address and
 * drawn from the buyer's quota — and worse, the *amend* lookup below keys on
 * `customer_id`, so a second `extract_order` call in the same conversation
 * found the friend's fresh order and overwrote it. On 2026-08-24, inside one
 * minute, Cila's 5-porsi package became Naya's 20-porsi package: one order row
 * survived, carrying Cila's `created_at` and Naya's contents, and Cila's order
 * had to be rebuilt by hand from the transcript.
 *
 * The number is what makes this safe. Matching on the name is guesswork —
 * "Nayla bukan Naya" is a correction, not a second customer — while a phone
 * number that differs from the sender's is a fact, and `customers.phone_number`
 * is unique (migration 065), so Postgres enforces the idempotency instead of a
 * heuristic. It also settles the case a name never could: when Cila writes in
 * herself, her message lands on the record that already holds her order.
 *
 * Without a usable number we identify nobody, so we write nothing and ask. The
 * one exception is the payment-proof recovery path (`sendPaymentInfo: false`),
 * where money has already arrived: blocking there would throw away the order
 * behind a real transfer, so it falls back to an ordinary order on the buyer.
 */
async function resolveBeneficiary(
  input: ExtractedOrderInput,
  buyerPhone: string,
  askable: boolean,
): Promise<BeneficiaryTarget> {
  const name = (input.beneficiary_name ?? "").trim();
  const rawPhone = (input.beneficiary_phone ?? "").trim();
  if (!name && !rawPhone) return { kind: "self" };

  const phone = normalizePhone(rawPhone);
  // The buyer answering with their own number is ordering for themselves. The
  // model reaches for these fields whenever a name it does not recognise turns
  // up in the chat, and a customer giving their own number back is common.
  if (phone && samePhone(phone, buyerPhone)) return { kind: "self" };

  const who = name || "temannya";
  if (!phone) {
    if (!askable) return { kind: "self" };
    return {
      kind: "ask",
      missing: "phone",
      message: `Boleh minta nomor WhatsApp ${who} dulu kak? 🙏 Pesanan untuk beliau kami catat atas namanya sendiri, biar kuota dan alamat pengirimannya tidak tertukar dengan pesanan kakak. Kalau nomornya belum ada, saya bantu proses lewat tim kami ya kak.`,
    };
  }

  const db = createAdminClient();
  const { data: existing } = await db
    .from("customers")
    .select("id, name")
    .eq("phone_number", phone)
    .maybeSingle();
  if (existing) {
    const onRecord = (existing.name ?? "").trim();
    // The record is theirs and everything on it — address, area, kitchen — was
    // put there by their own orders. Nothing here writes to it; see the
    // customer update at the end of `createOrderFromExtraction`.
    if (!onRecord && (!name || isPlaceholderName(name))) {
      if (!askable) return { kind: "self" };
      return { kind: "ask", missing: "name", message: askBeneficiaryName() };
    }
    return {
      kind: "third_party",
      customerId: existing.id,
      name: onRecord || name,
      phone,
      created: false,
    };
  }

  // A new record for someone we have never spoken to. The kitchen sheet prints
  // this name on every delivery row, so it is not optional — the dash it prints
  // instead had to be chased down by hand on 2026-08-26.
  if (!name || isPlaceholderName(name)) {
    if (!askable) return { kind: "self" };
    return { kind: "ask", missing: "name", message: askBeneficiaryName() };
  }

  const { data: created, error } = await db
    .from("customers")
    .insert({
      phone_number: phone,
      name,
      // The address on this call is the beneficiary's: the model was told to
      // extract the package being discussed, and this package is delivered to
      // them.
      address: input.address?.trim() || null,
      area: input.area?.trim() || null,
      sub_area: input.sub_area?.trim() || null,
      google_maps_link: input.maps_link?.trim() || null,
      delivery_route: getDeliveryRoute(input.area ?? null),
    })
    .select("id")
    .single();

  if (error || !created) {
    // The unique index is the arbiter, so a duplicate here means the row was
    // written between the lookup and the insert. Take theirs.
    const { data: raced } = await db
      .from("customers")
      .select("id, name")
      .eq("phone_number", phone)
      .maybeSingle();
    if (raced) {
      return {
        kind: "third_party",
        customerId: raced.id,
        name: (raced.name ?? name).trim(),
        phone,
        created: false,
      };
    }
    console.error(
      "[extract-order] could not create beneficiary record:",
      error?.message,
    );
    await sendPushToAllAdmins(
      "Pesanan untuk orang lain gagal dibuat",
      `${who} (${phone}): ${error?.message ?? "insert returned no row"}`,
      "/inbox",
      "high",
    );
    throw new Error(
      `resolveBeneficiary: could not create ${phone} — ${error?.message ?? "no row returned"}`,
    );
  }

  // Mirrors the webhook's first-contact setup. Both tables are keyed on the
  // customer and read with `.update()` elsewhere, which silently does nothing
  // when the row is missing.
  await Promise.all([
    db
      .from("customer_flags")
      .upsert(
        { customer_id: created.id },
        { onConflict: "customer_id", ignoreDuplicates: true },
      ),
    db
      .from("customer_state")
      .upsert(
        { customer_id: created.id },
        { onConflict: "customer_id", ignoreDuplicates: true },
      ),
  ]);

  await logEdit({
    db,
    actor: systemActor("extract-order"),
    entityType: "customers",
    entityId: created.id,
    action: "create",
    changes: {
      reason: "package bought for them by another customer",
      name,
      phone_number: phone,
      bought_by: buyerPhone,
    },
  });

  return {
    kind: "third_party",
    customerId: created.id,
    name,
    phone,
    created: true,
  };
}

function askBeneficiaryName(): string {
  return "Boleh tahu nama lengkap penerima pesanan keduanya kak? 🙏 Nama itu yang kami tulis di paket dan di catatan pengiriman, biar tidak tertukar dengan pesanan kakak sendiri ya.";
}

/**
 * What the caller has left to do once the order is written.
 *
 * `sendPayment` is non-null only under `deferPaymentMessage`, and only when a
 * payment message is actually owed. Calling it saves the message, sends it and
 * records the receipt — everything the non-deferred path does inline.
 */
export type CreateOrderResult = {
  sendPayment: (() => Promise<void>) | null;
};

const NOTHING_TO_SEND: CreateOrderResult = { sendPayment: null };

export async function createOrderFromExtraction(
  customerId: string,
  phone: string,
  input: ExtractedOrderInput,
  options?: { sendPaymentInfo?: boolean; deferPaymentMessage?: boolean },
): Promise<CreateOrderResult> {
  const db = createAdminClient();
  const sendPaymentInfo = options?.sendPaymentInfo ?? true;
  // The bank details are the last thing the customer should read, not the
  // first. The model answers and calls extract_order in the same turn, and the
  // reply is sent from the webhook long after the tool runs — behind the
  // validator, the language guard and a typing delay — so sending from here put
  // the transfer instructions in front of the sentence that introduces them.
  // The webhook passes this and sends the returned message after its reply.
  const deferPaymentMessage = options?.deferPaymentMessage ?? false;

  // Whose package this is. Everything below writes against `orderCustomerId`:
  // the order, its delivery rows and its quota belong to the person who eats
  // the food. Everything *said* goes to `phone`/`customerId`, the buyer — they
  // are the one in the conversation, and the beneficiary may never have written
  // to us at all.
  const beneficiary = await resolveBeneficiary(input, phone, sendPaymentInfo);
  if (beneficiary.kind === "ask") {
    const conversationId = await saveMessage({
      customerId,
      role: "assistant",
      content: beneficiary.message,
      modelUsed: "system",
    });
    const askMessageId = await sendTextMessage(phone, beneficiary.message);
    await updateMessageReceipt({
      conversationId,
      whatsappMessageId: askMessageId,
      status: "sent",
    });
    // The buyer may simply not know the number, and pushing them for a third
    // party's contact details is a bad trade against the sale. The prompt tells
    // the model to escalate at that point; this makes sure an admin sees it
    // even when the model does not.
    await sendPushToAllAdmins(
      "Pesanan untuk orang lain — data penerima belum lengkap",
      `${input.customer_name || phone} memesan untuk orang lain; ${beneficiary.missing === "phone" ? "nomor" : "nama"} penerimanya belum ada`,
      "/inbox",
      "medium",
    );
    console.log(
      `[extract-order] third-party order withheld for ${customerId}: no beneficiary ${beneficiary.missing}`,
    );
    return NOTHING_TO_SEND;
  }
  const orderCustomerId =
    beneficiary.kind === "third_party" ? beneficiary.customerId : customerId;
  const payerCustomerId =
    beneficiary.kind === "third_party" ? customerId : null;

  // Never ask a customer for money before we know their name.
  //
  // `shouldRecordName` deliberately refuses to store "Kak", "Customer" or
  // "unknown", so a nameless order is not a gap that closes itself: nothing
  // asks again once the order exists, and `/dapur/[id]` prints "—" where the
  // name goes, on every delivery row. +6287895957020 paid Rp 145.000 on
  // 2026-08-26 for five September dinners and went to the kitchen as a dash;
  // the name was not recoverable from anything we held — not the transcript,
  // not the transfer receipt — so it had to be asked for by hand.
  //
  // The prompt has told the model to ask since 2026-08-26 and it still skipped
  // it, which is the usual reason a rule like this ends up in code.
  //
  // Refuse the whole order, not just the payment message: an order created
  // without bank details leaves the customer waiting on a transfer they were
  // never asked to make. Returning here lets the model call extract_order
  // again next turn, once it has the name.
  //
  // Only when we are the ones asking for money. The payment-proof path
  // (`sendPaymentInfo: false`) is a customer who has *already* transferred —
  // blocking there would throw away the order behind a real payment.
  if (sendPaymentInfo && beneficiary.kind === "self") {
    const { data: named } = await db
      .from("customers")
      .select("name")
      .eq("id", customerId)
      .maybeSingle();
    const onRecord = (named?.name ?? "").trim();
    if (!onRecord && !shouldRecordName(input.customer_name, null)) {
      const askMsg =
        "Sebelum saya siapkan pesanannya, boleh tahu nama kakak dulu? 🙏 Nama ini yang kami tulis di paket dan di catatan pengiriman, biar tidak tertukar dengan pesanan lain ya kak.";
      const conversationId = await saveMessage({
        customerId,
        role: "assistant",
        content: askMsg,
        modelUsed: "system",
      });
      const askMessageId = await sendTextMessage(phone, askMsg);
      await updateMessageReceipt({
        conversationId,
        whatsappMessageId: askMessageId,
        status: "sent",
      });
      console.log(
        `[extract-order] order withheld for ${customerId}: no name on record and none given`,
      );
      return NOTHING_TO_SEND;
    }
  }

  // Never sell a package without knowing which days it is for.
  //
  // `delivery_schedule` is a required field of the tool now, and `[]` is the
  // answer for a customer who books day by day — so an absent field is the
  // model failing to ask, not a customer with nothing to say. It used to be
  // optional, and whenever it was missing this handler invented a week out of
  // a meal-preference enum: Senin–Jumat, both meals, starting tomorrow. That
  // put food on the kitchen sheet for dates nobody had confirmed.
  //
  // Refuse the whole order rather than create one with a null schedule: an
  // order is what sends the bank details, and a customer should not be asked
  // to transfer before we can say when they eat. Returning here writes nothing
  // and lets the model call again next turn with the days — or with `[]`.
  //
  // Not on the payment-proof path (`sendPaymentInfo: false`): that customer has
  // already transferred, and blocking there would throw away a real payment.
  if (sendPaymentInfo && input.delivery_schedule === undefined) {
    const askMsg =
      "Baik kak, sebelum saya proses — untuk tanggal pengirimannya mau mulai kapan dan hari apa saja ya? 🙏 Kalau kakak mau pesan harian saja (tidak ditentukan dari sekarang), boleh juga kok, tinggal kabari saya tiap mau kirim.";
    const conversationId = await saveMessage({
      customerId,
      role: "assistant",
      content: askMsg,
      modelUsed: "system",
    });
    const askMessageId = await sendTextMessage(phone, askMsg);
    await updateMessageReceipt({
      conversationId,
      whatsappMessageId: askMessageId,
      status: "sent",
    });
    console.log(
      `[extract-order] order withheld for ${customerId}: no delivery_schedule`,
    );
    return NOTHING_TO_SEND;
  }

  const schedule = input.delivery_schedule?.length
    ? input.delivery_schedule
    : null;
  const rawPackageSize = schedule
    ? schedule.reduce((sum, s) => sum + s.portions, 0)
    : input.package_size;
  // package_size is NOT NULL and is the one field the model still drops — two
  // replays on 2026-08-19 threw on the insert and left the customer with no
  // order at all. Floor it at the smallest package we sell rather than fail.
  const flooredPackageSize = Math.max(
    typeof rawPackageSize === "number" && rawPackageSize > 0
      ? rawPackageSize
      : 0,
    await minPackageSize(),
  );

  const sortedSchedule = schedule
    ? [...schedule].sort((a, b) => a.date.localeCompare(b.date))
    : null;
  // orders.start_date is NOT NULL, and the model does not always supply one —
  // a renewal ("mau lanjut 5 porsi lagi") often carries no date at all. The
  // insert then failed, the error was discarded, and the customer still got the
  // transfer details: Julian S paid Rp 145.000 on 2026-08-18 against an order
  // that does not exist. Fall back to the next day we actually deliver.
  const startDate = sortedSchedule
    ? sortedSchedule[0].date
    : (input.start_date ?? nextDeliveryDate());
  const endDate = sortedSchedule
    ? sortedSchedule[sortedSchedule.length - 1].date
    : (input.end_date ?? null);

  // A duration in weeks is a portion count for a customer who named no days:
  // "2 minggu, 1 porsi" is 10 portions. Our week is Senin-Jumat unless the
  // customer picks Sabtu, and the bot must never hold an order open asking which.
  const inbound = await customerMessages(customerId);
  const weeks = inbound.map(statedWeeks).find((n) => n !== null) ?? null;

  // portions_per_delivery is one day's portions and is a required field, so it
  // is a better source for this than the meal-preference enum it replaced —
  // that enum could only ever say 1 or 2.
  const portionsPerDay = Math.max(1, input.portions_per_delivery ?? 1);
  // `inbound` is newest first, so this is the last total the customer stated —
  // and a customer who changes their mind means the newer number. Tiwi asked for
  // 8 porsi, was told 8 was off the list, wrote "Boleh 6 porsi dulu kak", and
  // the order was still written for 8. Anything below the smallest package we
  // sell is describing a delivery ("1 porsi"), not the order.
  const floor = await minPackageSize();
  const statedTotal =
    inbound
      .map(statedBareTotal)
      .find((n): n is number => n !== null && n >= floor) ?? null;
  const weeksSize =
    weeks !== null && statedTotal === null && !sortedSchedule
      ? weeks * 5 * portionsPerDay
      : null;

  const nasiMerah = input.nasi_merah === true;
  // Money that has moved outranks every number in the conversation.
  const paidSize =
    beneficiary.kind === "self"
      ? await packageSizeMatchingPayment(customerId, nasiMerah)
      : null;

  // Every one of these overrides is read out of the buyer's chat, and in a
  // conversation holding two packages the numbers in it belong to whichever
  // one was being discussed at the time. Applied to a friend's package they
  // are worse than useless: Naya's "20 porsi" and her Rp 540.000 are precisely
  // what turned Cila's 5-porsi order into a copy of Naya's. For someone else's
  // package, the size the model extracted for that package is all we have.
  const chatSize =
    beneficiary.kind === "self" ? (paidSize ?? statedTotal ?? weeksSize) : null;
  const packageSize = chatSize ?? flooredPackageSize;
  if (packageSize !== flooredPackageSize) {
    console.log(
      `[extract-order] package_size ${flooredPackageSize} -> ${packageSize} (paid=${paidSize} stated=${statedTotal} weeks=${weeksSize})`,
    );
  }
  // A customer already being asked to pay for an order has one order, not two.
  // The model re-calls extract_order whenever it restates the summary, and each
  // call used to insert: Sherine Fayola was billed Rp 145.000, then Rp 540.000,
  // then Rp 1.040.000 within thirteen minutes on 2026-08-19, for one purchase.
  // Amend the open one instead — nothing has been drawn against an unpaid order,
  // so size, price and balance all move with it.
  const { data: openOrder } = await db
    .from("orders")
    .select("id, created_at")
    .eq("customer_id", orderCustomerId)
    .eq("status", "pending_payment")
    .gt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (openOrder) {
    // Its schedule was built from the superseded size and is replaced below.
    // An unpaid order should hold no rows at all now — they are written at
    // mark_paid — but orders created before that change still carry theirs, and
    // an amend must not leave the old size's days behind.
    await db.from("daily_deliveries").delete().eq("order_id", openOrder.id);
  }

  // Which meal goes to the customer's second address. The bot has been offering
  // split deliveries for months — makan siang ke kampus, makan malam ke kost —
  // while every row written here went to slot 1, so the kitchen sheet showed one
  // address for both meals and nothing said the promise had been dropped.
  // A slot 2 is only real when there is an address to put in it: this order's,
  // or one already on the record from an earlier order.
  const { data: addressRow } = await db
    .from("customers")
    .select("address_2, area, subcontractor_id")
    .eq("id", orderCustomerId)
    .maybeSingle();
  const secondMeal =
    input.address_2?.trim() || addressRow?.address_2?.trim()
      ? input.address_2_meal
      : undefined;
  const lunchSlot = secondMeal === "lunch" ? 2 : 1;
  const dinnerSlot = secondMeal === "dinner" ? 2 : 1;

  // The model drops subcontractor_id far more often than the tool's `required`
  // list suggests — Cindi's 2026-08-21 order came through with a null one, and
  // 33 open orders carry one. A null kitchen makes the order invisible on
  // /dapur/[id] and on the kitchen's own sheet, which both filter strictly on
  // it, so the food is never cooked and nothing anywhere says why. Fall back
  // the way an admin would: the kitchen this customer already buys from, then
  // the only active kitchen covering their area. Two candidates is a real
  // choice between kitchens and stays null for an admin to make.
  let subcontractorId =
    input.subcontractor_id ?? addressRow?.subcontractor_id ?? null;
  if (!subcontractorId) {
    const { data: activeSubs } = await db
      .from("subcontractors")
      .select("id, delivery_areas")
      .eq("is_active", true);
    const area = (input.area ?? addressRow?.area ?? "").trim().toLowerCase();
    const covering = area
      ? (activeSubs ?? []).filter((sub) =>
          ((sub.delivery_areas as string[] | null) ?? []).some(
            (a) => a.trim().toLowerCase() === area,
          ),
        )
      : [];
    if (covering.length === 1) {
      subcontractorId = covering[0].id;
      console.log(
        `[extract-order] no dapur from the model — assigned ${subcontractorId}, the only active kitchen covering ${area}`,
      );
    }
  }

  // Which size, and what it costs. Both settled here rather than earlier
  // because M is per kitchen — like `delivery_areas` — so the size cannot be
  // known until the kitchen is. A kitchen that does not cook M must never be
  // sent an M row: its sheet would say M, it would cook S, and the customer
  // would have paid the surcharge for a dish nobody made. The prompt only
  // offers M where a kitchen has it; this is the guard behind that, and it
  // writes S rather than refusing, so the order still exists and the price
  // matches the food.
  let portionSize = normalizeSize(input.size);
  if (portionSize === "m") {
    const { data: kitchen } = subcontractorId
      ? await db
          .from("subcontractors")
          .select("offers_size_m")
          .eq("id", subcontractorId)
          .maybeSingle()
      : { data: null };
    if (!kitchen?.offers_size_m) {
      console.log(
        `[extract-order] size M asked for but dapur ${subcontractorId ?? "(none)"} does not cook it — writing S`,
      );
      portionSize = "s";
    }
  }

  const { price_per_portion: pricePerPortion, total_price: totalPrice } =
    await getExtractedOrderPricing(
      packageSize,
      nasiMerah,
      orderCustomerId,
      portionSize,
    );

  // The days this order will be cooked on, settled here and stored on the
  // order. They are NOT written as delivery rows yet: rows land at mark_paid.
  // Writing them here put food on a kitchen's sheet for an order nobody had
  // paid for — GET /api/deliveries/daily-sheet keys on delivery_date alone and
  // filters on no order status, so three unpaid orders were carrying 37 future
  // portions on 2026-08-28.
  //
  // Stored exactly as the customer asked, Minggu and libur nasional included.
  // mark_paid drops the days we do not deliver on (`isDeliveryDay`) when it
  // materialises the rows, which leaves those portions unbooked for the
  // customer to move, and keeps this column an honest record of what they
  // asked for.
  //
  // Null only when the customer books day by day and the model sent `[]`. A
  // model that sends nothing at all never reaches here — see the guard above.
  const requestedSchedule:
    | { date: string; meal_type: string; portions: number }[]
    | null = sortedSchedule
    ? sortedSchedule.map((s) => ({
        date: s.date,
        meal_type: s.meal_type,
        portions: s.portions,
      }))
    : null;

  const orderFields = {
    customer_id: orderCustomerId,
    // Null on an ordinary order. Set only when someone else is paying, which
    // is what tells the unpaid sweep and the payment page whose thread the
    // money is coming from.
    paid_by_customer_id: payerCustomerId,
    package_size: packageSize,
    price_per_portion: pricePerPortion,
    total_price: totalPrice,
    addon_cost_per_portion: nasiMerah ? NASI_MERAH_SURCHARGE : 0,
    // NOT NULL, and the model omits it whenever the conversation never
    // discussed portions per day — Nadya's 20-porsi order was rejected on
    // it and she got nothing. One per delivery is the prompt's own default.
    portions_per_delivery: input.portions_per_delivery ?? 1,
    portions_lunch: input.portions_lunch ?? 0,
    portions_dinner: input.portions_dinner ?? 0,
    // The days the customer asked for. mark_paid turns these into delivery
    // rows; nothing else reads them. Null when they bought quota without
    // naming days, which is most of the book — those customers book per day.
    requested_schedule: requestedSchedule as
      | import("@/types/database").Json
      | null,
    lunch_address_slot: lunchSlot,
    dinner_address_slot: dinnerSlot,
    custom_schedule: (input.custom_schedule ?? null) as
      | import("@/types/database").Json
      | null,
    start_date: startDate,
    end_date: endDate,
    size: portionSize,
    subcontractor_id: subcontractorId,
    status: "pending_payment" as const,
    confirmed_at: new Date().toISOString(),
  };

  const { data: insertedOrder, error: insertError } = openOrder
    ? await db
        .from("orders")
        .update(orderFields)
        .eq("id", openOrder.id)
        .select("id")
        .single()
    : await db.from("orders").insert(orderFields).select("id").single();
  if (openOrder) {
    console.log(
      `[extract-order] amended open order ${openOrder.id} to ${packageSize} porsi instead of creating a second`,
    );
  }

  // The insert error used to be discarded. A model that omitted one required
  // field — package_size on Nadya's 2026-08-18 replay — produced a rejected
  // insert, an undefined `insertedOrder`, and then a crash further down on
  // `customer_name.split`, with nothing anywhere saying the order had failed.
  // The customer had already been told it was being placed.
  if (insertError || !insertedOrder) {
    console.error("[extract-order] order insert failed:", insertError, input);
    await sendPushToAllAdmins(
      "Order creation failed",
      `${input.customer_name ?? phone}: ${insertError?.message ?? "insert returned no row"}`,
      "/inbox",
      "high",
    );
    throw new Error(
      `createOrderFromExtraction: order insert failed — ${insertError?.message ?? "no row returned"}`,
    );
  }

  const { data: existingCustomer } = await db
    .from("customers")
    .select("name, notes, portions_remaining, avg_price_per_portion")
    .eq("id", orderCustomerId)
    .single();
  const oldRemaining = existingCustomer?.portions_remaining ?? 0;
  const oldAvg = existingCustomer?.avg_price_per_portion ?? 0;
  const newRemaining = oldRemaining + packageSize;
  const newAvg = Math.round(
    (oldRemaining * oldAvg + packageSize * pricePerPortion) / newRemaining,
  );

  const nameFromModel = (input.customer_name ?? "").trim();
  // A name already on the record is the one an admin or an earlier order put
  // there, and the model's is whatever signature it read off the chat: Julian S
  // was renamed to "Julian" by an order he never placed. Only ever fill a name
  // that is missing.
  const existingName = (existingCustomer?.name ?? "").trim();
  const rawNameForRecord =
    !existingName && nameFromModel && !isPlaceholderName(nameFromModel)
      ? nameFromModel
      : null;
  // A replayed conversation carries the real customer's name, and writing it to
  // the demo row put a second "Nadya" in the inbox beside the real one — an
  // admin one tap away from answering a replay instead of a customer.
  const nameForRecord = isDemoPhone(phone)
    ? demoDisplayName(phone)
    : rawNameForRecord;

  const addressType = input.address?.trim()
    ? await classifyAddress(input.address)
    : null;

  // The kitchen has no other way to learn about an accepted custom request:
  // nothing that materialises a delivery row writes a per-row note, and the AI
  // summary is written later and only sometimes mentions it.
  const kitchenNote = mergeKitchenNote(
    existingCustomer?.notes ?? null,
    input.catatan ?? "",
  );
  // Someone else's record is not ours to rewrite. Every field below is taken
  // from the order being placed, and on a third-party order that order was
  // placed by the buyer — so writing it through would move Cila's address, area
  // and kitchen to Naya's. The guards on each field only protect against a
  // *blank* value, never against a value belonging to the wrong person. A
  // beneficiary record we just created already carries this order's address;
  // one that already existed carries their own, put there by their own orders.
  if (beneficiary.kind === "self") {
    await db
      .from("customers")
      .update({
        ...(rawNameForRecord ? { name: nameForRecord } : {}),
        // Only overwrite the address when this order actually carried one. A
        // renewal extracted from chat alone has none, and writing it through
        // blanked the address of a customer we have been delivering to for
        // months.
        ...(input.address?.trim()
          ? {
              address: input.address,
              address_type: addressType,
            }
          : {}),
        ...(input.area?.trim()
          ? {
              area: input.area,
              sub_area: input.sub_area ?? null,
              delivery_route: getDeliveryRoute(input.area),
            }
          : {}),
        portions_remaining: newRemaining,
        avg_price_per_portion: newAvg,
        ...(kitchenNote ? { notes: kitchenNote } : {}),
        ...(input.maps_link ? { google_maps_link: input.maps_link } : {}),
        // Same rule as the primary address: only written when this order
        // carried one, so a renewal extracted from chat alone cannot blank it.
        ...(input.address_2?.trim() ? { address_2: input.address_2 } : {}),
        ...(input.area_2?.trim()
          ? { area_2: input.area_2, sub_area_2: input.sub_area_2 ?? null }
          : {}),
        ...(input.maps_link_2 ? { google_maps_link_2: input.maps_link_2 } : {}),
        ...(input.subcontractor_id
          ? { subcontractor_id: input.subcontractor_id }
          : {}),
      })
      .eq("id", orderCustomerId);
  }

  await db
    .from("customer_state")
    .update({
      state: "ordering",
      updated_at: new Date().toISOString(),
    })
    .eq("customer_id", orderCustomerId);

  if (!sendPaymentInfo) return NOTHING_TO_SEND;

  const [bankName, bankAccountNumber, bankAccountName] = await Promise.all([
    getSetting("bank_name"),
    getSetting("bank_account_number"),
    getSetting("bank_account_name"),
  ]);
  // The model sometimes fills customer_name with the literal "unknown" when the
  // customer never typed their name — Julian S's renewal was addressed to
  // "kak unknown" on 2026-08-18. Neither that nor an empty string is a name.
  //
  // Greet from the name we KNOW, not from `rawNameForRecord`. That one is a
  // write-flag: it is deliberately null whenever the customer already has a
  // name, because we only ever fill a name that is missing. Reading it here
  // inverted the greeting — first-time buyers got "kak Surya" and renewals got
  // "Terima kasih kak kak!", because the fallback "kak" landed after the "kak"
  // already in the sentence. Six payment messages went out that way between
  // 2026-08-19 and 2026-08-25, to four customers, Kurniadi Tan's Rp 540.000
  // renewal among them. The honorific now lives in `greeting`, so a customer we
  // have no name for gets a clean "Terima kasih kak!" instead of a doubled one.
  // On a third-party order `existingCustomer` is the beneficiary's row, so
  // greeting from it would address the buyer by their friend's name. Greet the
  // person we are actually talking to.
  const buyerName =
    beneficiary.kind === "third_party"
      ? (
          (
            await db
              .from("customers")
              .select("name")
              .eq("id", customerId)
              .maybeSingle()
          ).data?.name ?? ""
        ).trim()
      : (existingName || rawNameForRecord || "").trim();
  const displayName = buyerName.split(" ")[0];
  const greeting = displayName ? `kak ${displayName}` : "kak";
  // Two packages in one conversation means two transfer messages to the same
  // person, and an unlabelled pair is unpayable: the buyer cannot tell which
  // amount is which. Say whose package this one is.
  const forWhom =
    beneficiary.kind === "third_party"
      ? `\n\n📦 Ini untuk pesanan atas nama ${beneficiary.name}.`
      : "";
  const nominal = `Rp ${totalPrice.toLocaleString("id-ID")}`;
  const paymentMsg = `Terima kasih ${greeting}! 🎉${forWhom} Silakan transfer ke:\n🏦 ${bankName}: ${bankAccountNumber}\n👤 a.n. ${bankAccountName}\n💰 Nominal: ${nominal}\n\nSetelah transfer, mohon kirim bukti pembayaran ya kak.\n\n${WINDOW_NOTICE_SHORT}`;

  // One purchase, one request for money.
  //
  // The model re-calls extract_order every time it restates the summary, and
  // the amend above is what stops that becoming a second order — but the
  // payment message was composed and sent on the amend path too. Rian's demo
  // run on 2026-08-29 got the whole transfer block twice, bank number, amount
  // and 24h notice, once when he said the schedule was open and again when he
  // confirmed. A customer asked to transfer twice cannot tell whether it is two
  // bills.
  //
  // Keyed on what was actually sent, not on the order: an amend that changes
  // the amount composes a different message and goes out, and an order whose
  // payment message never reached the customer — the process died, or it was
  // created from a payment proof — is asked normally, because nothing matching
  // is on record. That matters more since the send moved after the reply: the
  // gap where a death loses the message is wider now, and the next turn has to
  // be able to recover it.
  if (openOrder) {
    const { data: alreadyAsked } = await db
      .from("conversations")
      .select("id")
      .eq("customer_id", customerId)
      .eq("role", "assistant")
      .gte("created_at", openOrder.created_at)
      .ilike("content", `%${bankAccountNumber}%`)
      .ilike("content", `%${nominal}%`)
      .limit(1)
      .maybeSingle();
    if (alreadyAsked) {
      console.log(
        `[extract-order] payment message for order ${openOrder.id} already sent (${nominal}) — not repeating it`,
      );
      return NOTHING_TO_SEND;
    }
  }

  const send = async () => {
    const conversationId = await saveMessage({
      customerId,
      role: "assistant",
      content: paymentMsg,
      modelUsed: modelTag("sonnet"),
    });
    const whatsappMessageId = await sendTextMessage(phone, paymentMsg);
    await updateMessageReceipt({
      conversationId,
      whatsappMessageId,
      status: "sent",
    });
  };

  if (deferPaymentMessage) return { sendPayment: send };
  await send();
  return NOTHING_TO_SEND;
}
