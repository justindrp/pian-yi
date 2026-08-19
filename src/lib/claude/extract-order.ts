import { demoDisplayName, isDemoPhone } from "@/lib/whatsapp/demo";
import type Anthropic from "@anthropic-ai/sdk";
import { getSetting } from "@/lib/cache/settings";
import { classifyAddress } from "@/lib/claude/classify-address";
import {
  NO_THINKING,
  SONNET_MODEL,
  getAnthropicClient,
} from "@/lib/claude/client";
import {
  loadHistory,
  saveMessage,
  updateMessageReceipt,
} from "@/lib/claude/conversation";
import { isClosedHoliday } from "@/lib/holidays/id";
import {
  FIXED_SCHEDULE_PREFS,
  buildRecurringDeliveryRows,
  portionsInRange,
} from "@/lib/orders/build-recurring-deliveries";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDeliveryRoute } from "@/lib/utils/format";
import { sendTextMessage } from "@/lib/whatsapp/client";
import { WINDOW_NOTICE_SHORT } from "@/lib/whatsapp/window-notice";

export interface DeliveryScheduleSlot {
  date: string;
  meal_type: string;
  portions: number;
}

export interface ExtractedOrderInput {
  customer_name: string;
  package_size: number;
  portions_per_delivery: number;
  portions_lunch?: number;
  portions_dinner?: number;
  address: string;
  maps_link: string;
  area: string;
  sub_area?: string;
  meal_time_preference?: string;
  custom_schedule?: Record<string, unknown>;
  delivery_schedule?: DeliveryScheduleSlot[];
  start_date?: string;
  end_date?: string;
  subcontractor_id?: string;
  size?: string;
  nasi_merah?: boolean;
}

export interface ExtractedOrderPricing {
  price_per_portion: number;
  total_price: number;
}

export type ExtractedOrderReview = ExtractedOrderInput & ExtractedOrderPricing;
const LEARNED_CONTEXT_START = "[AI learned context]";
const LEARNED_CONTEXT_END = "[/AI learned context]";

// One shared property schema. The webhook used to carry its own copy and it had
// drifted: `delivery_schedule` was missing there entirely, so the live bot could
// never book a customer's named dates at order creation — only a start/end range
// it then filled in by weekday. Cindy Angelia's 11, 12, 13, 14, 18 Agustus is
// exactly the shape that loses (11–18 by weekday is a different set of days).
export const EXTRACT_ORDER_PROPERTIES = {
  customer_name: { type: "string" },
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
  area: {
    type: "string",
    enum: ["BSD Baru", "BSD Lama", "Gading Serpong", "Alam Sutera", "Karawaci"],
  },
  sub_area: {
    type: "string",
    description:
      "Sub-location within the area: district name for houses, apartment name for apartments, building name for offices",
  },
  meal_time_preference: {
    type: "string",
    enum: [
      "lunch_only",
      "dinner_only",
      "both_fixed",
      "per_day_decision",
      "default_lunch",
      "default_dinner",
      "custom_schedule",
    ],
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
      "Every delivery day the customer named, one entry per day per meal. Use this whenever the days are known — including a plain Senin–Jumat run and especially a set with gaps (11, 12, 13, 14, 18). Omitting it leaves the days to be guessed from start_date/end_date by weekday, which is a different set of days whenever the customer skipped one. package_size must equal the sum of all slot portions.",
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
    enum: ["s"],
  },
  nasi_merah: {
    type: "boolean",
    description:
      "True when the customer asked for nasi merah. Adds Rp 5.000 per portion to the price and records the same amount as what the kitchen charges us.",
  },
} as const;

export const EXTRACT_ORDER_TOOL: Anthropic.Messages.Tool = {
  name: "extract_order",
  description:
    "Extracts all order details the customer has already provided earlier in this conversation.",
  input_schema: {
    type: "object",
    properties: EXTRACT_ORDER_PROPERTIES,
    required: [
      "customer_name",
      "package_size",
      "portions_per_delivery",
      "address",
      "area",
    ],
  },
};

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
      tools: [EXTRACT_ORDER_TOOL],
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
 */
export function statedBareTotal(text: string): number | null {
  const sizes = new Set<number>();
  for (const match of text.matchAll(
    /(?<![\d.,])(\d+)\s*porsi(?!\s*(?:\/|per\s)?\s*(?:hari|pengiriman|kali|x\b))/gi,
  )) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0 && n <= LARGEST_PLAUSIBLE_SIZE) sizes.add(n);
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

/** A customer who wrote one of these asked for lunch. */
const LUNCH_WORDS = /\b(makan siang|siang aja|siang saja|siang doang|lunch)\b/i;

/** A customer who never wrote one of these never asked for dinner. */
const DINNER_WORDS = /\b(malam|dinner|keduanya|2\s*(x|kali)\s*sehari|dua kali)\b/i;

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
async function minPackageSize(): Promise<number> {
  const db = createAdminClient();
  const { data } = await db
    .from("pricing_tiers")
    .select("portions")
    .order("portions", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.portions ?? 5;
}

export async function getExtractedOrderPricing(
  packageSize: number,
  nasiMerah = false,
): Promise<ExtractedOrderPricing> {
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
  const pricePerPortion = basePrice + (nasiMerah ? NASI_MERAH_SURCHARGE : 0);
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
    if (d.getDay() !== 0 && !isClosedHoliday(ymd)) return ymd;
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * The meal schedule the customer's last package ran on, when it was a standing
 * pattern. Only used to fill a renewal the model left blank.
 */
async function previousMealTimePreference(
  customerId: string,
): Promise<string | null> {
  const db = createAdminClient();
  const { data } = await db
    .from("orders")
    .select("meal_time_preference")
    .eq("customer_id", customerId)
    .not("meal_time_preference", "is", null)
    .order("created_at", { ascending: false })
    .limit(5);
  for (const row of data ?? []) {
    if (
      row.meal_time_preference &&
      FIXED_SCHEDULE_PREFS.includes(row.meal_time_preference)
    ) {
      return row.meal_time_preference;
    }
  }
  return null;
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
export async function resizePendingOrderFromMessage(
  customerId: string,
  phone: string,
  text: string,
): Promise<boolean> {
  const stated = statedBareTotal(text);
  if (stated === null) return false;
  if (stated < (await minPackageSize())) return false;

  const db = createAdminClient();
  const { data: order } = await db
    .from("orders")
    .select("id, package_size, portions_remaining, addon_cost_per_portion")
    .eq("customer_id", customerId)
    .eq("status", "pending_payment")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!order || order.package_size === stated) return false;

  // The add-on is charged through at cost and already sits inside
  // price_per_portion, so re-price with it rather than dropping it.
  const nasiMerah = (order.addon_cost_per_portion ?? 0) > 0;
  const { price_per_portion: pricePerPortion, total_price: totalPrice } =
    await getExtractedOrderPricing(stated, nasiMerah);

  // Nothing has been drawn against an unpaid order, so the balance moves with
  // the size.
  const { error } = await db
    .from("orders")
    .update({
      package_size: stated,
      portions_remaining: stated,
      price_per_portion: pricePerPortion,
      total_price: totalPrice,
    })
    .eq("id", order.id);
  if (error) {
    console.error("[extract-order] pending order resize failed:", error.message);
    return false;
  }

  const [bankName, bankAccountNumber, bankAccountName] = await Promise.all([
    getSetting("bank_name"),
    getSetting("bank_account_number"),
    getSetting("bank_account_name"),
  ]);
  const msg = `Baik kak, pesanannya kami ubah jadi ${stated} porsi ya 😊\n\n💰 Nominal baru: Rp ${totalPrice.toLocaleString("id-ID")}\n🏦 ${bankName}: ${bankAccountNumber}\n👤 a.n. ${bankAccountName}\n\nSetelah transfer, mohon kirim bukti pembayaran ya kak 🙏`;
  const conversationId = await saveMessage({
    customerId,
    role: "assistant",
    content: msg,
    modelUsed: "sonnet-5",
  });
  const whatsappMessageId = await sendTextMessage(phone, msg);
  await updateMessageReceipt({
    conversationId,
    whatsappMessageId,
    status: "sent",
  });
  console.log(
    `[extract-order] pending order ${order.id} resized ${order.package_size} -> ${stated}`,
  );
  return true;
}

export async function createOrderFromExtraction(
  customerId: string,
  phone: string,
  input: ExtractedOrderInput,
  options?: { sendPaymentInfo?: boolean },
): Promise<void> {
  const db = createAdminClient();
  const sendPaymentInfo = options?.sendPaymentInfo ?? true;

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

  // A renewal extracted from chat rarely names a meal preference — the customer
  // has one and neither of them restates it. Left null the order booked as
  // per_day_decision, which delivery generation deliberately skips, so Julian S's
  // second 5-porsi package on 2026-08-18 was created correctly and then produced
  // no deliveries at all. Inherit the schedule his previous package ran on. A
  // genuinely new customer with nothing on file still falls through to
  // per_day_decision: defaulting them into a week of generated days would book
  // deliveries for every bebas customer who never asked for a fixed schedule.
  const extractedPreference =
    input.meal_time_preference ??
    (await previousMealTimePreference(customerId)) ??
    "per_day_decision";

  // The customer's own words are the only evidence that they asked for dinner.
  // Lina Marlianty wrote "2 minggu dl aja.. 1 porsi" and never mentioned malam;
  // the recovery extraction booked her both_fixed and sold 18 porsi for an order
  // that was 10 porsi of lunch. Siang is the documented default, so a both_fixed
  // no message supports is downgraded rather than trusted.
  const inbound = await customerMessages(customerId);
  const askedForDinner = inbound.some((m) => DINNER_WORDS.test(m));
  const askedForLunch = inbound.some((m) => LUNCH_WORDS.test(m));
  // And the mirror of it: a customer who did say "makan siang" must not fall
  // through to per_day_decision, which delivery generation skips. Dewi wrote
  // "Makan siang" and named her days on 2026-07-28; the order was created at the
  // right size and price and produced no delivery rows at all.
  const mealTimePreference =
    extractedPreference === "both_fixed" && !askedForDinner
      ? "lunch_only"
      : extractedPreference === "per_day_decision" &&
          (askedForLunch || askedForDinner)
        ? askedForLunch && askedForDinner
          ? "both_fixed"
          : askedForLunch
            ? "lunch_only"
            : "dinner_only"
        : extractedPreference;

  // The schedule is the order. A customer who says "20 hari mulai 10 Agustus,
  // selesai 8 September" has described a range that yields exactly 20 delivery
  // days, and the model's prose arithmetic said 22 — so the order was sold at
  // 22 porsi while writing 20 delivery rows, incoherent with its own schedule.
  // When both dates and a standing meal pattern are present, count the days the
  // range actually produces instead of trusting the number the model wrote.
  const rangeSize =
    !sortedSchedule && endDate && FIXED_SCHEDULE_PREFS.includes(mealTimePreference)
      ? portionsInRange(
          {
            portions_per_delivery: input.portions_per_delivery ?? 1,
            portions_lunch: input.portions_lunch ?? null,
            portions_dinner: input.portions_dinner ?? null,
            meal_time_preference: mealTimePreference,
            lunch_address_slot: 1,
            dinner_address_slot: 1,
          },
          startDate,
          endDate,
        )
      : null;
  // A duration in weeks is a portion count: our week is Senin-Jumat unless the
  // customer picks Sabtu, and the bot must never hold an order open asking which.
  const portionsPerDay = mealTimePreference === "both_fixed" ? 2 : 1;
  const weeks = inbound.map(statedWeeks).find((n) => n !== null) ?? null;
  const statedTotal = inbound.map(statedBareTotal).find((n) => n !== null);
  const weeksSize =
    weeks !== null && !statedTotal && !sortedSchedule
      ? weeks * 5 * portionsPerDay
      : null;

  const nasiMerah = input.nasi_merah === true;
  // Money that has moved outranks every number in the conversation.
  const paidSize = await packageSizeMatchingPayment(customerId, nasiMerah);

  const packageSize = paidSize ?? weeksSize ?? rangeSize ?? flooredPackageSize;
  if (packageSize !== flooredPackageSize) {
    console.log(
      `[extract-order] package_size ${flooredPackageSize} -> ${packageSize} (paid=${paidSize} weeks=${weeksSize} range=${rangeSize})`,
    );
  }
  const { price_per_portion: pricePerPortion, total_price: totalPrice } =
    await getExtractedOrderPricing(packageSize, nasiMerah);

  const { data: insertedOrder, error: insertError } = await db
    .from("orders")
    .insert({
      customer_id: customerId,
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
      portions_remaining: packageSize,
      meal_time_preference: input.meal_time_preference ?? "per_day_decision",
      custom_schedule: (input.custom_schedule ?? null) as
        | import("@/types/database").Json
        | null,
      start_date: startDate,
      end_date: endDate,
      size: "s",
      subcontractor_id: input.subcontractor_id ?? null,
      status: "pending_payment",
      confirmed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

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

  {
    const today = new Date().toISOString().slice(0, 10);
    // The model supplies delivery_schedule when it has spelled the days out.
    // When it has not, a fixed-schedule order used to get an order row and no
    // deliveries at all — nothing else fills them in, so the customer had paid
    // for a package that would never be cooked. Derive the days from the same
    // helper the generate-deliveries cron uses instead of depending on the
    // model to emit an array of dates.
    const derived =
      !sortedSchedule && FIXED_SCHEDULE_PREFS.includes(mealTimePreference)
        ? buildRecurringDeliveryRows(
            {
              customer_id: customerId,
              order_id: insertedOrder.id,
              start_date: startDate,
              end_date: endDate,
              package_size: packageSize,
              meal_time_preference: mealTimePreference,
              portions_per_delivery: input.portions_per_delivery ?? 1,
              portions_lunch: input.portions_lunch ?? null,
              portions_dinner: input.portions_dinner ?? null,
              lunch_address_slot: 1,
              dinner_address_slot: 1,
              subcontractor_id: input.subcontractor_id ?? null,
            },
            today,
          )
        : [];

    const rows = sortedSchedule
      ? sortedSchedule.map((s) => ({
          delivery_date: s.date,
          customer_id: customerId,
          order_id: insertedOrder.id,
          meal_type: s.meal_type,
          portions: s.portions,
          subcontractor_id: input.subcontractor_id ?? null,
          address_slot: 1,
          status: s.date < today ? "delivered" : "scheduled",
        }))
      : derived.map((r) => ({
          delivery_date: r.delivery_date,
          customer_id: r.customer_id,
          order_id: r.order_id,
          meal_type: r.meal_type as string,
          portions: r.portions,
          subcontractor_id: r.subcontractor_id,
          address_slot: r.address_slot,
          status: r.status as string,
        }));

    // The kitchens are shut on libur nasional, so a row on one is a delivery
    // nobody cooks. record_daily_order already drops them; a package booked in
    // one go had no such filter.
    const deliverable = rows.filter((r) => !isClosedHoliday(r.delivery_date));

    if (deliverable.length > 0) {
      await db.from("daily_deliveries").upsert(deliverable, {
        onConflict: "delivery_date,customer_id,meal_type",
        ignoreDuplicates: true,
      });
    }
  }

  const { data: existingCustomer } = await db
    .from("customers")
    .select("portions_remaining, avg_price_per_portion")
    .eq("id", customerId)
    .single();
  const oldRemaining = existingCustomer?.portions_remaining ?? 0;
  const oldAvg = existingCustomer?.avg_price_per_portion ?? 0;
  const newRemaining = oldRemaining + packageSize;
  const newAvg = Math.round(
    (oldRemaining * oldAvg + packageSize * pricePerPortion) / newRemaining,
  );

  const nameFromModel = (input.customer_name ?? "").trim();
  const rawNameForRecord =
    nameFromModel && nameFromModel.toLowerCase() !== "unknown"
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
  await db
    .from("customers")
    .update({
      ...(rawNameForRecord ? { name: nameForRecord } : {}),
      // Only overwrite the address when this order actually carried one. A
      // renewal extracted from chat alone has none, and writing it through blanked
      // the address of a customer we have been delivering to for months.
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
      ...(input.maps_link ? { google_maps_link: input.maps_link } : {}),
      ...(input.subcontractor_id
        ? { subcontractor_id: input.subcontractor_id }
        : {}),
    })
    .eq("id", customerId);

  await db
    .from("customer_state")
    .update({
      state: "ordering",
      updated_at: new Date().toISOString(),
    })
    .eq("customer_id", customerId);

  if (!sendPaymentInfo) return;

  const [bankName, bankAccountNumber, bankAccountName] = await Promise.all([
    getSetting("bank_name"),
    getSetting("bank_account_number"),
    getSetting("bank_account_name"),
  ]);
  // The model sometimes fills customer_name with the literal "unknown" when the
  // customer never typed their name — Julian S's renewal was addressed to
  // "kak unknown" on 2026-08-18. Neither that nor an empty string is a name.
  const displayName = rawNameForRecord?.split(" ")[0] ?? "kak";
  const paymentMsg = `Terima kasih kak ${displayName}! 🎉 Silakan transfer ke:\n🏦 ${bankName}: ${bankAccountNumber}\n👤 a.n. ${bankAccountName}\n💰 Nominal: Rp ${totalPrice.toLocaleString("id-ID")}\n\nSetelah transfer, mohon kirim bukti pembayaran ya kak.\n\n${WINDOW_NOTICE_SHORT}`;
  const conversationId = await saveMessage({
    customerId,
    role: "assistant",
    content: paymentMsg,
    modelUsed: "sonnet-5",
  });
  const whatsappMessageId = await sendTextMessage(phone, paymentMsg);
  await updateMessageReceipt({
    conversationId,
    whatsappMessageId,
    status: "sent",
  });
}
