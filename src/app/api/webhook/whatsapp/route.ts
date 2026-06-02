import type Anthropic from "@anthropic-ai/sdk";
import type { NextRequest } from "next/server";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { getAnthropicClient, SONNET_MODEL } from "@/lib/claude/client";
import { loadHistory, saveMessage } from "@/lib/claude/conversation";
import { matchDeliveryPhoto } from "@/lib/claude/photo-matcher";
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
import { downloadMedia, sendImageMessage, sendTextMessage, sendTypingIndicator } from "@/lib/whatsapp/client";
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

  // Check if sender is a subcontractor admin
  const { data: subcontractor } = await db
    .from("subcontractors")
    .select("id, name")
    .or(`admin_phone.eq.${message.from},admin_phone_2.eq.${message.from}`)
    .eq("is_active", true)
    .maybeSingle();

  if (subcontractor) {
    await handleSubcontractorMessage(
      message,
      subcontractor.id,
      subcontractor.name,
    );
    await db
      .from("processed_messages")
      .update({ processed_at: new Date().toISOString() })
      .eq("message_id", message.messageId);
    return;
  }

  // Kill switch
  const chatbotEnabled = await getSetting("chatbot_enabled");
  if (chatbotEnabled !== "true") {
    const tmpl = await getTemplate("chatbot_unavailable");
    await sendTextMessage(message.from, tmpl);
    return;
  }

  // Upsert customer (must happen before message-type routing so we can check state)
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

  // Check flags
  const { data: flags } = await db
    .from("customer_flags")
    .select("escalated_to_human, is_blacklisted")
    .eq("customer_id", customerId)
    .single();

  if (flags?.is_blacklisted) return;

  if (flags?.escalated_to_human) {
    const escalatedText =
      message.type === "text"
        ? (message.text ?? "")
        : message.type === "image"
          ? "[Image]"
          : `[${message.type}]`;
    const escalatedIntent = await classifyIntent(escalatedText).catch(() => "other");
    await saveMessage({
      customerId,
      role: "user",
      content: escalatedText,
      messageId: message.messageId,
      intent: escalatedIntent,
      messageType: message.type === "image" ? "image" : "text",
    });
    await sendPushToAllAdmins(
      "New message from escalated customer",
      `${message.from}: ${escalatedText.slice(0, 80)}`,
      "/inbox",
      "medium",
    );
    await db
      .from("processed_messages")
      .update({ processed_at: new Date().toISOString() })
      .eq("message_id", message.messageId);
    return;
  }

  // Payment proof: capture image when customer is awaiting payment
  if (message.type === "image" && message.imageId) {
    const { data: stateRow } = await db
      .from("customer_state")
      .select("state")
      .eq("customer_id", customerId)
      .single();

    if (stateRow?.state === "awaiting_payment") {
      await handlePaymentProofImage(message, customerId, customer.name, message.from);
      await db
        .from("processed_messages")
        .update({ processed_at: new Date().toISOString() })
        .eq("message_id", message.messageId);
      return;
    }

    const tmpl = await getTemplate("text_only");
    await sendTextMessage(message.from, tmpl);
    return;
  }

  // Non-text messages
  let text: string;
  if (message.type === "location") {
    const parts = [message.locationName, message.locationAddress].filter(Boolean);
    let zoneNote = "";
    const { locationLat: lat, locationLng: lng } = message;
    if (lat !== undefined && lng !== undefined) {
      const inBsd = lat >= -6.35 && lat <= -6.22 && lng >= 106.62 && lng <= 106.72;
      if (inBsd) zoneNote = lng < 106.667361 ? " — BSD Baru" : " — BSD Lama";
    }
    text = `[Lokasi dibagikan: ${parts.join(", ")}${zoneNote}]`;
  } else if (message.type !== "text") {
    const tmpl = await getTemplate("text_only");
    await sendTextMessage(message.from, tmpl);
    return;
  } else {
    text = message.text ?? "";
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

  // Notify admins of every incoming message
  const customerName = customer?.name ?? message.from;
  await sendPushToAllAdmins(
    `New message from ${customerName}`,
    text.slice(0, 100),
    "/inbox",
    "low",
  );

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
  const intent = await classifyIntent(text).catch(() => "other");

  // Load history
  const history = await loadHistory(customerId);

  // Customer state
  const { data: stateRow } = await db
    .from("customer_state")
    .select("state, menu_shown")
    .eq("customer_id", customerId)
    .single();

  // Casual mode coin flip
  const casualProbRaw = await getSetting("casual_mode_probability");
  const casualProb = Number.parseFloat(casualProbRaw) || 0.5;
  const casual = Math.random() < casualProb;

  // Detect Maps link in current message or history so we can inject it explicitly
  const mapsLinkRegex = /https?:\/\/(?:maps\.app\.goo\.gl|maps\.google\.com\/maps|goo\.gl\/maps)\S*/;
  let detectedMapsLink: string | null = text.match(mapsLinkRegex)?.[0] ?? null;
  if (!detectedMapsLink) {
    for (const msg of history) {
      if (msg.role !== "user") continue;
      const msgText = Array.isArray(msg.content)
        ? msg.content.map((b) => (typeof b === "object" && "text" in b ? b.text : "")).join(" ")
        : String(msg.content);
      const found = msgText.match(mapsLinkRegex)?.[0];
      if (found) { detectedMapsLink = found; break; }
    }
  }

  // Send welcome sequence on first contact — deterministic, not Claude's decision
  let menuShown = stateRow?.menu_shown ?? false;
  if (!menuShown) {
    const [welcomeText, menuDapur1Url, menuDapur2Url, priceListUrl] = await Promise.all([
      getSetting("welcome_message"),
      getSetting("weekly_menu_image_url"),
      getSetting("weekly_menu_image_url_dapur2"),
      getSetting("price_list_image_url"),
    ]);

    if (welcomeText) await sendTextMessage(message.from, welcomeText);
    if (priceListUrl) await sendImageMessage(message.from, priceListUrl, "Harga & Area Pengiriman");
    if (menuDapur1Url) await sendImageMessage(message.from, menuDapur1Url, "Menu Dapur 1");
    if (menuDapur2Url) await sendImageMessage(message.from, menuDapur2Url, "Menu Dapur 2");

    await db
      .from("customer_state")
      .update({ menu_shown: true })
      .eq("customer_id", customerId);
    menuShown = true;

    // Welcome sequence already greets the customer; skip Claude reply to avoid
    // a redundant second hello. Save the incoming message and mark processed.
    await saveMessage({
      customerId,
      role: "user",
      content: text,
      messageId: message.messageId,
      intent,
    });
    await db
      .from("processed_messages")
      .update({ processed_at: new Date().toISOString() })
      .eq("message_id", message.messageId);
    return;
  }

  // Load active dapurs and active order quota in parallel
  const [{ data: activeSubs }, { data: activeOrderRow }] = await Promise.all([
    db
      .from("subcontractors")
      .select("id, customer_nickname")
      .eq("is_active", true)
      .not("customer_nickname", "is", null),
    db
      .from("orders")
      .select("id, portions_remaining, package_size, portions_per_delivery, meal_time_preference")
      .eq("customer_id", customerId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const dapurOptions = (activeSubs ?? [])
    .filter((s): s is { id: string; customer_nickname: string } => s.customer_nickname !== null)
    .map((s) => ({ id: s.id, nickname: s.customer_nickname }));
  const activeOrder = activeOrderRow
    ? {
        id: activeOrderRow.id,
        portionsRemaining: activeOrderRow.portions_remaining,
        packageSize: activeOrderRow.package_size,
        portionsPerDelivery: activeOrderRow.portions_per_delivery,
        mealTimePreference: activeOrderRow.meal_time_preference,
      }
    : null;

  // Build system prompt
  const systemPrompt = await buildSystemPrompt({
    casual,
    customerState: stateRow?.state ?? "new",
    customerName: customer.name,
    detectedMapsLink,
    menuShown,
    dapurOptions,
    activeOrder,
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
          maps_link: { type: "string", description: "Google Maps link provided by the customer" },
          area: { type: "string", enum: ["BSD Baru", "BSD Lama", "Gading Serpong", "Alam Sutera"] },
          meal_time_preference: { type: "string", enum: ["lunch_only", "dinner_only", "both_fixed", "per_day_decision", "default_lunch", "default_dinner", "custom_schedule"] },
          custom_schedule: { type: "object" },
          start_date: {
            type: "string",
            description: "ISO date string YYYY-MM-DD",
          },
          end_date: {
            type: "string",
            description: "ISO date string YYYY-MM-DD — the customer's requested last delivery date",
          },
          subcontractor_id: {
            type: "string",
            description: "UUID of the chosen dapur (from the dapur ID mapping in the system prompt)",
          },
        },
        required: [
          "customer_name",
          "package_size",
          "portions_per_delivery",
          "address",
          "maps_link",
          "area",
          ...(dapurOptions.length > 0 ? ["subcontractor_id"] : []),
        ],
      },
    },
    {
      name: "record_daily_order",
      description:
        "Called when a customer with an active quota-based order requests a delivery for the next day. Inserts the daily delivery and decrements their quota. Only call this for customers who already have an active order with portions_remaining > 0.",
      input_schema: {
        type: "object",
        properties: {
          delivery_date: {
            type: "string",
            description: "ISO date string YYYY-MM-DD — the requested delivery date (tomorrow unless customer specifies otherwise)",
          },
          meal_type: {
            type: "string",
            enum: ["lunch", "dinner", "both"],
          },
          portions: {
            type: "number",
            description: "Total portions to deduct from quota (e.g. 2 for 1-portion keduanya order — 1 lunch + 1 dinner)",
          },
          notes: { type: "string" },
        },
        required: ["delivery_date", "meal_type", "portions"],
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
  } catch (err) {
    console.error("[webhook] Claude API error:", (err as Error).message);
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
    intent,
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

  // Send reply with typing indicator + delay
  if (replyText) {
    const base =
      Number.parseFloat(await getSetting("typing_delay_base_seconds")) || 3;
    const perChar =
      Number.parseFloat(await getSetting("typing_delay_per_char_seconds")) ||
      0.05;
    const max =
      Number.parseFloat(await getSetting("typing_delay_max_seconds")) || 12;
    const delay = calcTypingDelay(replyText.length, base, perChar, max);

    await sendTypingIndicator(message.from, message.messageId);
    await sleep(delay);
    await sendTextMessage(message.from, replyText);
  }

  // Mark processed
  await db
    .from("processed_messages")
    .update({ processed_at: new Date().toISOString() })
    .eq("message_id", message.messageId);
}

async function handleSubcontractorMessage(
  message: import("@/lib/whatsapp/types").WhatsAppMessage,
  subcontractorId: string,
  subcontractorName: string,
): Promise<void> {
  const db = createAdminClient();

  if (message.type === "image" && message.imageId) {
    // Download from WhatsApp
    let imageBuffer: Buffer;
    try {
      imageBuffer = await downloadMedia(message.imageId);
    } catch (err) {
      console.error("[webhook] failed to download media:", (err as Error).message);
      return;
    }

    // Upload to Supabase Storage
    const today = new Date().toISOString().slice(0, 10);
    const storagePath = `${subcontractorId}/${today}/${message.messageId}.jpg`;
    const { error: uploadErr } = await db.storage
      .from("delivery-proofs")
      .upload(storagePath, imageBuffer, { contentType: "image/jpeg", upsert: false });

    if (uploadErr) {
      console.error("[webhook] storage upload failed:", uploadErr.message);
      return;
    }

    const { data: urlData } = db.storage
      .from("delivery-proofs")
      .getPublicUrl(storagePath);

    // Create delivery_proofs row
    const { data: proof } = await db
      .from("delivery_proofs")
      .insert({
        sender_phone: message.from,
        subcontractor_id: subcontractorId,
        whatsapp_message_id: message.messageId,
        caption: message.imageCaption ?? null,
        image_url: urlData.publicUrl,
        status: "pending",
      })
      .select("id")
      .single();

    if (proof) {
      matchDeliveryPhoto(proof.id).catch(console.error);
    }
  } else if (message.type === "text" && message.text) {
    await sendPushToAllAdmins(
      `Message from ${subcontractorName}`,
      message.text.slice(0, 120),
      "/deliveries",
      "medium",
    );
  }
}

async function handlePaymentProofImage(
  message: import("@/lib/whatsapp/types").WhatsAppMessage,
  customerId: string,
  customerName: string | null,
  phone: string,
): Promise<void> {
  const db = createAdminClient();

  let imageUrl: string | null = null;
  if (message.imageId) {
    try {
      const imageBuffer = await downloadMedia(message.imageId);
      const today = new Date().toISOString().slice(0, 10);
      const storagePath = `${customerId}/${today}/${message.messageId}.jpg`;
      const { error: uploadErr } = await db.storage
        .from("payment-proofs")
        .upload(storagePath, imageBuffer, { contentType: "image/jpeg", upsert: false });
      if (!uploadErr) {
        const { data: urlData } = db.storage.from("payment-proofs").getPublicUrl(storagePath);
        imageUrl = urlData.publicUrl;
      } else {
        console.error("[webhook] payment proof upload failed:", uploadErr.message);
      }
    } catch (err) {
      console.error("[webhook] payment proof download failed:", (err as Error).message);
    }
  }

  await db
    .from("orders")
    .update({ status: "payment_proof_received", payment_proof_url: imageUrl })
    .eq("customer_id", customerId)
    .eq("status", "pending_payment");

  await db
    .from("customer_state")
    .update({ state: "payment_proof_received", updated_at: new Date().toISOString() })
    .eq("customer_id", customerId);

  await saveMessage({
    customerId,
    role: "user",
    content: "[Bukti pembayaran dikirim]",
    messageId: message.messageId,
    messageType: "image",
  });

  const confirmMsg =
    "Terima kasih kak! Bukti pembayaran sudah kami terima ya. Kami akan segera memverifikasi pembayaranmu dan menghubungimu kembali.";
  await saveMessage({ customerId, role: "assistant", content: confirmMsg, modelUsed: "human" });
  await sendTextMessage(phone, confirmMsg);

  await sendPushToAllAdmins(
    `Bukti bayar diterima — ${customerName ?? phone}`,
    "Cek halaman Payments untuk konfirmasi",
    "/payments",
    "medium",
  );
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
      maps_link: string;
      area: string;
      meal_time_preference?: string;
      custom_schedule?: Record<string, unknown>;
      start_date?: string;
      end_date?: string;
      subcontractor_id?: string;
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
      maps_link: input.maps_link,
      area: input.area,
      meal_time_preference: input.meal_time_preference ?? "per_day_decision",
      custom_schedule: (input.custom_schedule ?? null) as
        | import("@/types/database").Json
        | null,
      start_date: (input.start_date ?? null) as string,
      end_date: input.end_date ?? null,
      subcontractor_id: input.subcontractor_id ?? null,
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
        ...(input.subcontractor_id ? { subcontractor_id: input.subcontractor_id } : {}),
      })
      .eq("id", customerId);

    await db
      .from("customer_state")
      .update({
        state: "awaiting_payment",
        updated_at: new Date().toISOString(),
      })
      .eq("customer_id", customerId);

    // Send payment details
    const [bankName, bankAccountNumber, bankAccountName] = await Promise.all([
      getSetting("bank_name"),
      getSetting("bank_account_number"),
      getSetting("bank_account_name"),
    ]);
    const displayName = input.customer_name.split(" ")[0];
    const paymentMsg = `Terima kasih kak ${displayName}! 🎉 Silakan transfer ke:\n🏦 ${bankName}: ${bankAccountNumber}\n👤 a.n. ${bankAccountName}\n💰 Nominal: Rp ${totalPrice.toLocaleString("id-ID")}\n\nSetelah transfer, mohon kirim bukti pembayaran ya kak.`;
    await saveMessage({ customerId, role: "assistant", content: paymentMsg, modelUsed: "sonnet-4-6" });
    await sendTextMessage(phone, paymentMsg);
  } else if (tool.name === "record_daily_order") {
    const input = tool.input as {
      delivery_date: string;
      meal_type: "lunch" | "dinner" | "both";
      portions: number;
      notes?: string;
    };

    const { data: order } = await db
      .from("orders")
      .select("id, portions_remaining, subcontractor_id")
      .eq("customer_id", customerId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!order) {
      console.error("[webhook] record_daily_order: no active order for customer", customerId);
      return;
    }

    if (order.portions_remaining <= 0) {
      console.warn("[webhook] record_daily_order: quota exhausted for order", order.id);
      return;
    }

    await db.from("daily_deliveries").insert({
      order_id: order.id,
      customer_id: customerId,
      delivery_date: input.delivery_date,
      meal_type: input.meal_type,
      portions: input.portions,
      subcontractor_id: order.subcontractor_id,
      status: "scheduled",
      notes: input.notes ?? null,
    });

    await db
      .from("orders")
      .update({ portions_remaining: Math.max(0, order.portions_remaining - input.portions) })
      .eq("id", order.id);

    await sendPushToAllAdmins(
      `Order harian — ${customerName ?? phone}`,
      `${input.delivery_date} ${input.meal_type} × ${input.portions} porsi`,
      "/deliveries",
      "low",
    );
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
