import type Anthropic from "@anthropic-ai/sdk";
import type { NextRequest } from "next/server";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { getAnthropicClient, SONNET_MODEL } from "@/lib/claude/client";
import { loadHistory, saveMessage } from "@/lib/claude/conversation";
import { classifyIntent } from "@/lib/claude/prompts/classifier";
import { buildSystemPrompt } from "@/lib/claude/prompts/system";
import {
  checkRateLimit,
  detectEcho,
  detectInjection,
  isCircuitOpen,
  recordFailure,
  recordSuccess,
  updateTokenCount,
} from "@/lib/claude/safety";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { calcTypingDelay, sleep } from "@/lib/utils/delay";
import { sendTextMessage } from "@/lib/whatsapp/client";
import {
  parseMessage,
  type WhatsAppWebhookPayload,
} from "@/lib/whatsapp/types";
import { verifySignature } from "@/lib/whatsapp/webhook";

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(req: NextRequest): Promise<Response> {
  const body = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  if (!verifySignature(body, signature)) {
    return new Response("Forbidden", { status: 403 });
  }

  // Return 200 immediately
  const response = new Response("OK", { status: 200 });
  processWebhookAsync(JSON.parse(body) as WhatsAppWebhookPayload).catch(
    console.error,
  );
  return response;
}

async function processWebhookAsync(
  payload: WhatsAppWebhookPayload,
): Promise<void> {
  const message = parseMessage(payload);
  if (!message) return;

  const db = createAdminClient();

  // Idempotency check
  const { data: existing } = await db
    .from("processed_messages")
    .select("message_id")
    .eq("message_id", message.messageId)
    .single();
  if (existing) return;

  await db.from("processed_messages").insert({ message_id: message.messageId });

  // Kill switch
  const chatbotEnabled = await getSetting("chatbot_enabled");
  if (chatbotEnabled !== "true") {
    const tmpl = await getTemplate("chatbot_unavailable");
    await sendTextMessage(message.from, tmpl);
    return;
  }

  // Non-text messages
  if (message.type !== "text") {
    const tmpl = await getTemplate("text_only");
    await sendTextMessage(message.from, tmpl);
    return;
  }

  const text = message.text ?? "";

  // Upsert customer
  const { data: customer } = await db
    .from("customers")
    .upsert(
      { phone_number: message.from, updated_at: new Date().toISOString() },
      { onConflict: "phone_number" },
    )
    .select("id, name")
    .single();

  if (!customer) return;

  const customerId = customer.id;

  // Upsert companion rows
  await Promise.all([
    db
      .from("customer_rate_limits")
      .upsert(
        { customer_id: customerId },
        { onConflict: "customer_id", ignoreDuplicates: true },
      ),
    db
      .from("customer_flags")
      .upsert(
        { customer_id: customerId },
        { onConflict: "customer_id", ignoreDuplicates: true },
      ),
    db
      .from("customer_state")
      .upsert(
        { customer_id: customerId },
        { onConflict: "customer_id", ignoreDuplicates: true },
      ),
  ]);

  // Check escalated_to_human
  const { data: flags } = await db
    .from("customer_flags")
    .select("escalated_to_human, is_blacklisted")
    .eq("customer_id", customerId)
    .single();

  if (flags?.is_blacklisted) return;

  if (flags?.escalated_to_human) {
    await saveMessage({
      customerId,
      role: "user",
      content: text,
      messageId: message.messageId,
    });
    await sendPushToAllAdmins(
      "New message from escalated customer",
      `${message.from}: ${text.slice(0, 80)}`,
      "/inbox",
      "medium",
    );
    await db
      .from("processed_messages")
      .update({ processed_at: new Date().toISOString() })
      .eq("message_id", message.messageId);
    return;
  }

  // Rate limit check
  const rateCheck = await checkRateLimit(customerId);
  if (!rateCheck.allowed) {
    const tmpl = await getTemplate("rate_limit_exceeded");
    await sendTextMessage(message.from, tmpl);
    await sendPushToAllAdmins(
      "Rate limit hit",
      `${message.from} hit ${rateCheck.reason}`,
      "/inbox",
      "medium",
    );
    return;
  }

  // Prompt injection
  if (detectInjection(text)) {
    const tmpl = await getTemplate("chatbot_unavailable");
    await sendTextMessage(message.from, tmpl);
    await db
      .from("customer_flags")
      .update({ is_suspicious: true })
      .eq("customer_id", customerId);
    return;
  }

  // Circuit breaker check
  if (isCircuitOpen()) {
    const tmpl = await getTemplate("chatbot_unavailable");
    await sendTextMessage(message.from, tmpl);
    return;
  }

  // Haiku classification
  await classifyIntent(text).catch(() => "other");

  // Load history
  const history = await loadHistory(customerId);

  // Customer state
  const { data: stateRow } = await db
    .from("customer_state")
    .select("state")
    .eq("customer_id", customerId)
    .single();

  // Casual mode coin flip
  const casualProbRaw = await getSetting("casual_mode_probability");
  const casualProb = Number.parseFloat(casualProbRaw) || 0.5;
  const casual = Math.random() < casualProb;

  // Build system prompt
  const systemPrompt = await buildSystemPrompt({
    casual,
    customerState: stateRow?.state ?? "new",
    customerName: customer.name,
  });

  // Tool definitions
  const tools: Anthropic.Messages.Tool[] = [
    {
      name: "extract_order",
      description:
        "Called when customer has confirmed their order summary with YA. Extracts all order details.",
      input_schema: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          package_size: { type: "number" },
          portions_per_delivery: { type: "number" },
          portions_lunch: { type: "number" },
          portions_dinner: { type: "number" },
          address: { type: "string" },
          area: { type: "string" },
          meal_time_preference: { type: "string" },
          custom_schedule: { type: "object" },
          start_date: {
            type: "string",
            description: "ISO date string YYYY-MM-DD",
          },
        },
        required: [
          "customer_name",
          "package_size",
          "portions_per_delivery",
          "address",
          "area",
          "meal_time_preference",
          "start_date",
        ],
      },
    },
    {
      name: "escalate_to_human",
      description:
        "Called when the conversation should be handed off to Annie.",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
    {
      name: "mark_payment_proof_received",
      description:
        "Called when customer indicates they have sent payment proof.",
      input_schema: { type: "object", properties: {} },
    },
  ];

  // Call Sonnet 4.6
  let claudeResponse: Anthropic.Messages.Message;
  try {
    const client = getAnthropicClient();
    claudeResponse = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [...history, { role: "user", content: text }],
      tools,
    });
    recordSuccess();
  } catch (_err) {
    await recordFailure();
    const tmpl = await getTemplate("chatbot_unavailable");
    await sendTextMessage(message.from, tmpl);
    return;
  }

  // Extract text reply and tool use
  let replyText = "";
  let toolUse: Anthropic.Messages.ToolUseBlock | null = null;

  for (const block of claudeResponse.content) {
    if (block.type === "text") replyText = block.text;
    if (block.type === "tool_use") toolUse = block;
  }

  if (!replyText && !toolUse) return;

  // Echo detection
  if (replyText) {
    const isEcho = await detectEcho(customerId, replyText);
    if (isEcho) {
      console.warn("[webhook] echo detected for customer", customerId);
      await sendPushToAllAdmins(
        "Echo detected",
        `Customer ${message.from}`,
        "/inbox",
        "medium",
      );
      return;
    }
  }

  // Save messages
  await saveMessage({
    customerId,
    role: "user",
    content: text,
    messageId: message.messageId,
  });

  if (replyText) {
    await saveMessage({
      customerId,
      role: "assistant",
      content: replyText,
      modelUsed: "sonnet-4-6",
      inputTokens: claudeResponse.usage.input_tokens,
      outputTokens: claudeResponse.usage.output_tokens,
    });
  }

  // Update token count
  await updateTokenCount(
    customerId,
    claudeResponse.usage.input_tokens + claudeResponse.usage.output_tokens,
  );

  // Handle tool use
  if (toolUse) {
    await handleToolUse(toolUse, customerId, message.from, customer.name);
  }

  // Update customer state based on stop reason
  if (claudeResponse.stop_reason === "end_turn" && replyText) {
    // State machine stays simple for Phase 1
  }

  // Send reply with typing delay
  if (replyText) {
    const base =
      Number.parseFloat(await getSetting("typing_delay_base_seconds")) || 3;
    const perChar =
      Number.parseFloat(await getSetting("typing_delay_per_char_seconds")) ||
      0.05;
    const max =
      Number.parseFloat(await getSetting("typing_delay_max_seconds")) || 12;
    const delay = calcTypingDelay(replyText.length, base, perChar, max);

    await sleep(delay);
    await sendTextMessage(message.from, replyText);
  }

  // Mark processed
  await db
    .from("processed_messages")
    .update({ processed_at: new Date().toISOString() })
    .eq("message_id", message.messageId);
}

async function handleToolUse(
  tool: Anthropic.Messages.ToolUseBlock,
  customerId: string,
  phone: string,
  customerName: string | null,
): Promise<void> {
  const db = createAdminClient();

  if (tool.name === "extract_order") {
    const input = tool.input as {
      customer_name: string;
      package_size: number;
      portions_per_delivery: number;
      portions_lunch?: number;
      portions_dinner?: number;
      address: string;
      area: string;
      meal_time_preference: string;
      custom_schedule?: Record<string, unknown>;
      start_date: string;
    };

    // Look up price
    const { data: tier } = await db
      .from("pricing_tiers")
      .select("price_per_portion")
      .eq("portions", input.package_size)
      .single();

    const pricePerPortion = tier?.price_per_portion ?? 0;
    const totalPrice = pricePerPortion * input.package_size;

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
      area: input.area,
      meal_time_preference: input.meal_time_preference,
      custom_schedule: (input.custom_schedule ?? null) as
        | import("@/types/database").Json
        | null,
      start_date: input.start_date,
      status: "pending_payment",
      confirmed_at: new Date().toISOString(),
    });

    // Update customer name and address
    await db
      .from("customers")
      .update({
        name: input.customer_name,
        address: input.address,
        area: input.area,
      })
      .eq("id", customerId);

    await db
      .from("customer_state")
      .update({
        state: "awaiting_payment",
        updated_at: new Date().toISOString(),
      })
      .eq("customer_id", customerId);
  } else if (tool.name === "escalate_to_human") {
    const input = tool.input as { reason: string };
    await db
      .from("customer_flags")
      .update({ escalated_to_human: true, escalation_reason: input.reason })
      .eq("customer_id", customerId);

    await sendPushToAllAdmins(
      "Human escalation requested",
      `${phone}: ${input.reason}`,
      "/inbox",
      "high",
    );
  } else if (tool.name === "mark_payment_proof_received") {
    await db
      .from("orders")
      .update({ status: "payment_proof_received" })
      .eq("customer_id", customerId)
      .eq("status", "pending_payment");

    await sendPushToAllAdmins(
      "Payment proof received",
      `From ${customerName ?? phone}`,
      "/payments",
      "medium",
    );
  }
}

export const dynamic = "force-dynamic";
