import type Anthropic from "@anthropic-ai/sdk";
import { getSetting } from "@/lib/cache/settings";
import { classifyAddress } from "@/lib/claude/classify-address";
import { getAnthropicClient, SONNET_MODEL } from "@/lib/claude/client";
import {
  loadHistory,
  saveMessage,
  updateMessageReceipt,
} from "@/lib/claude/conversation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDeliveryRoute } from "@/lib/utils/format";
import { sendTextMessage } from "@/lib/whatsapp/client";

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
  start_date?: string;
  end_date?: string;
  subcontractor_id?: string;
  size?: string;
}

export interface ExtractedOrderPricing {
  price_per_portion: number;
  total_price: number;
}

export type ExtractedOrderReview = ExtractedOrderInput & ExtractedOrderPricing;

export const EXTRACT_ORDER_TOOL: Anthropic.Messages.Tool = {
  name: "extract_order",
  description:
    "Extracts all order details the customer has already provided earlier in this conversation.",
  input_schema: {
    type: "object",
    properties: {
      customer_name: { type: "string" },
      package_size: { type: "number" },
      portions_per_delivery: { type: "number" },
      portions_lunch: { type: "number" },
      portions_dinner: { type: "number" },
      address: { type: "string" },
      maps_link: {
        type: "string",
        description: "Google Maps link provided by the customer",
      },
      area: {
        type: "string",
        enum: [
          "BSD Baru",
          "BSD Lama",
          "Gading Serpong",
          "Alam Sutera",
          "Karawaci",
        ],
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
      subcontractor_id: {
        type: "string",
        description: "UUID of the chosen dapur, from the dapur list given",
      },
      size: {
        type: "string",
        enum: ["s"],
      },
    },
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
): Promise<ExtractedOrderInput | null> {
  const history = await loadHistory(customerId);
  if (history.length === 0) return null;

  const db = createAdminClient();
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

  const system = `You are reviewing a WhatsApp conversation between a catering customer and our ordering bot. The customer has already provided their order details somewhere in this conversation. Call extract_order with every field you can determine from the conversation. Today is ${today} — resolve any relative dates the customer mentioned against that. Leave a field out only if the customer genuinely never provided it.

Available dapur (kitchen) IDs:
${dapurList || "none"}`;

  const anthropic = getAnthropicClient();
  let response: Anthropic.Messages.Message;
  try {
    response = await anthropic.messages.create({
      model: SONNET_MODEL,
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

  return toolUse.input as ExtractedOrderInput;
}

export async function getExtractedOrderPricing(
  packageSize: number,
): Promise<ExtractedOrderPricing> {
  const db = createAdminClient();
  const { data: tier } = await db
    .from("pricing_tiers")
    .select("price_per_portion")
    .lte("portions", packageSize)
    .order("portions", { ascending: false })
    .limit(1)
    .single();

  const pricePerPortion = tier?.price_per_portion ?? 0;
  return {
    price_per_portion: pricePerPortion,
    total_price: pricePerPortion * packageSize,
  };
}

/**
 * Same DB writes + payment-details WhatsApp message as the bot's own extract_order
 * tool handler — shared so the admin-triggered path and the live bot path can't drift apart.
 */
export async function createOrderFromExtraction(
  customerId: string,
  phone: string,
  input: ExtractedOrderInput,
): Promise<void> {
  const db = createAdminClient();
  const { price_per_portion: pricePerPortion, total_price: totalPrice } =
    await getExtractedOrderPricing(input.package_size);

  await db.from("orders").insert({
    customer_id: customerId,
    package_size: input.package_size,
    price_per_portion: pricePerPortion,
    total_price: totalPrice,
    portions_per_delivery: input.portions_per_delivery,
    portions_lunch: input.portions_lunch ?? 0,
    portions_dinner: input.portions_dinner ?? 0,
    portions_remaining: input.package_size,
    delivery_address: input.address,
    maps_link: input.maps_link,
    area: input.area,
    meal_time_preference: input.meal_time_preference ?? "per_day_decision",
    custom_schedule: (input.custom_schedule ?? null) as
      | import("@/types/database").Json
      | null,
    start_date: (input.start_date ?? null) as string,
    end_date: input.end_date ?? null,
    size: "s",
    subcontractor_id: input.subcontractor_id ?? null,
    status: "pending_payment",
    confirmed_at: new Date().toISOString(),
  });

  const { data: existingCustomer } = await db
    .from("customers")
    .select("portions_remaining, avg_price_per_portion")
    .eq("id", customerId)
    .single();
  const oldRemaining = existingCustomer?.portions_remaining ?? 0;
  const oldAvg = existingCustomer?.avg_price_per_portion ?? 0;
  const newRemaining = oldRemaining + input.package_size;
  const newAvg = Math.round(
    (oldRemaining * oldAvg + input.package_size * pricePerPortion) /
      newRemaining,
  );

  const addressType = await classifyAddress(input.address);
  await db
    .from("customers")
    .update({
      name: input.customer_name,
      address: input.address,
      area: input.area,
      sub_area: input.sub_area ?? null,
      delivery_route: getDeliveryRoute(input.area),
      address_type: addressType,
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

  const [bankName, bankAccountNumber, bankAccountName] = await Promise.all([
    getSetting("bank_name"),
    getSetting("bank_account_number"),
    getSetting("bank_account_name"),
  ]);
  const displayName = input.customer_name.split(" ")[0];
  const paymentMsg = `Terima kasih kak ${displayName}! 🎉 Silakan transfer ke:\n🏦 ${bankName}: ${bankAccountNumber}\n👤 a.n. ${bankAccountName}\n💰 Nominal: Rp ${totalPrice.toLocaleString("id-ID")}\n\nSetelah transfer, mohon kirim bukti pembayaran ya kak.`;
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
