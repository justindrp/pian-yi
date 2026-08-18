import type Anthropic from "@anthropic-ai/sdk";
import type { NextRequest } from "next/server";
import {
  getNeighborhoods,
  getSetting,
  getTemplate,
} from "@/lib/cache/settings";
import { analyzeCustomerMessage } from "@/lib/claude/analyze-customer-message";
import {
  extractText,
  getAnthropicClient,
  NO_THINKING,
  SONNET_MODEL,
} from "@/lib/claude/client";
import {
  loadHistory,
  saveMessage,
  updateMessageReceipt,
  type WhatsAppMessageStatus,
} from "@/lib/claude/conversation";
import {
  createOrderFromExtraction,
  type ExtractedOrderInput,
} from "@/lib/claude/extract-order";
import { looksEnglish, translateToIndonesian } from "@/lib/claude/language";
import { tryLearnCustomerContext } from "@/lib/claude/learn-context";
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
import { sanitizeReply } from "@/lib/claude/sanitize-reply";
import { validateReply } from "@/lib/claude/validate-reply";
import {
  hasCurrentOrder,
  normalizeCustomerState,
  shouldHandlePaymentProof,
} from "@/lib/customers/lifecycle";
import { shouldAutoResume } from "@/lib/customers/takeover";
import { describeMenuWeeks } from "@/lib/menu/week";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";
import { calcTypingDelay, sleep } from "@/lib/utils/delay";
import {
  downloadMedia,
  sendImageByUrl,
  sendTextMessage,
  sendTypingIndicator,
} from "@/lib/whatsapp/client";
import { storeInboundMedia } from "@/lib/whatsapp/media-store";
import {
  parseMessage,
  parseStatusUpdates,
  type WhatsAppWebhookPayload,
} from "@/lib/whatsapp/types";
import { verifySignature } from "@/lib/whatsapp/webhook";
import { WINDOW_NOTICE_WELCOME } from "@/lib/whatsapp/window-notice";

// How long an inbound message waits to see whether the customer is still
// typing. See the burst-coalescing block in processSavedCustomerMessage.
const BURST_WINDOW_MS = 15_000;

function normalizeWhatsAppStatus(status: string): WhatsAppMessageStatus | null {
  switch (status) {
    case "sent":
    case "delivered":
    case "read":
    case "failed":
      return status;
    default:
      return null;
  }
}

function toStatusTimestamp(timestamp?: string): string {
  const unixSeconds = Number(timestamp);
  if (!Number.isFinite(unixSeconds)) {
    return new Date().toISOString();
  }
  return new Date(unixSeconds * 1000).toISOString();
}

function formatLocationMessage(message: {
  locationName?: string;
  locationAddress?: string;
  locationLat?: number;
  locationLng?: number;
}): string {
  const parts = [message.locationName, message.locationAddress].filter(Boolean);
  const { locationLat: lat, locationLng: lng } = message;
  let zoneNote = "";
  let mapsLink = "";
  if (lat !== undefined && lng !== undefined) {
    const inBsd =
      lat >= -6.35 && lat <= -6.22 && lng >= 106.62 && lng <= 106.72;
    if (inBsd) zoneNote = lng < 106.667361 ? " — BSD Baru" : " — BSD Lama";
    mapsLink = `https://www.google.com/maps?q=${lat},${lng}`;
  }
  const label = parts.length > 0 ? parts.join(", ") : "Lokasi dibagikan";
  return mapsLink
    ? `[Lokasi dibagikan: ${label}${zoneNote}]\n${mapsLink}`
    : `[Lokasi dibagikan: ${label}${zoneNote}]`;
}

function formatDocumentMessage(message: {
  documentFilename?: string;
  documentCaption?: string;
}): string {
  const name = message.documentFilename ?? "dokumen";
  return message.documentCaption
    ? `[Dokumen: ${name}] ${message.documentCaption}`
    : `[Dokumen: ${name}]`;
}

function mediaMessageType(type: string): string {
  return type === "image" || type === "document" ? type : "text";
}

function mediaIdOf(message: {
  type: string;
  imageId?: string;
  documentId?: string;
}): string | undefined {
  if (message.type === "image") return message.imageId;
  if (message.type === "document") return message.documentId;
  return undefined;
}

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

  const payload = JSON.parse(body) as WhatsAppWebhookPayload;

  // Land the raw payload before acknowledging. The 200-then-process shape is
  // still right — Meta's timeout is short and processing calls the model — but
  // it used to mean a database outage ate customer messages in silence: the 200
  // had already gone out, so Meta never retried and nothing recorded that the
  // message ever arrived. Returning 500 when the write fails is what makes Meta
  // retry, and the stored row is what makes a failed *processing* run replayable.
  //
  // Only inbound messages are worth this. Status updates are delivery receipts
  // that Meta re-sends constantly; blocking on a write for those would add
  // latency to the noisiest half of the traffic to protect nothing.
  const message = parseMessage(payload);
  let eventId: string | null = null;
  if (message) {
    eventId = await storeWebhookEvent(payload, message.messageId);
    if (!eventId) {
      // Meta retries a 500, so the message is not lost — it arrives again once
      // the database is reachable, where the processed_messages guard makes the
      // duplicate harmless.
      return new Response("Storage unavailable", { status: 503 });
    }
  }

  // Return 200 immediately
  const response = new Response("OK", { status: 200 });
  processWebhookAsync(payload)
    .then(() => markWebhookEvent(eventId, null))
    .catch((err: unknown) => {
      console.error("[webhook] processing failed:", err);
      markWebhookEvent(eventId, err instanceof Error ? err.message : String(err));
    });
  return response;
}

/**
 * Write the payload to `webhook_events`, returning its row id — or null if the
 * database is unreachable, which is the caller's signal to refuse the delivery.
 * A Meta retry lands on the same `event_key` and returns the existing row.
 */
async function storeWebhookEvent(
  payload: WhatsAppWebhookPayload,
  eventKey: string,
): Promise<string | null> {
  try {
    const db = createAdminClient();
    const { data, error } = await db
      .from("webhook_events")
      .upsert(
        { event_key: eventKey, payload: payload as unknown as Json },
        { onConflict: "event_key" },
      )
      .select("id")
      .single();
    if (error) {
      console.error("[webhook] could not store event:", error.message);
      return null;
    }
    return data.id;
  } catch (err) {
    console.error("[webhook] could not store event:", err);
    return null;
  }
}

/** Mark an event finished, or record why it failed. Never throws. */
async function markWebhookEvent(
  eventId: string | null,
  error: string | null,
): Promise<void> {
  if (!eventId) return;
  try {
    const db = createAdminClient();
    await db
      .from("webhook_events")
      .update(
        error
          ? { error }
          : { processed_at: new Date().toISOString(), error: null },
      )
      .eq("id", eventId);
  } catch (err) {
    console.error("[webhook] could not mark event:", err);
  }
}

export async function processWebhookAsync(
  payload: WhatsAppWebhookPayload,
): Promise<void> {
  const statusUpdates = parseStatusUpdates(payload);
  if (statusUpdates.length > 0) {
    for (const statusUpdate of statusUpdates) {
      const normalizedStatus = normalizeWhatsAppStatus(statusUpdate.status);
      if (!normalizedStatus) continue;
      if (normalizedStatus === "failed" && statusUpdate.errors?.length) {
        console.error(
          "[webhook] message delivery failed:",
          statusUpdate.messageId,
          JSON.stringify(statusUpdate.errors),
        );
      }
      await updateMessageReceipt({
        messageId: statusUpdate.messageId,
        status: normalizedStatus,
        statusUpdatedAt: toStatusTimestamp(statusUpdate.timestamp),
      });
    }
    return;
  }

  const message = parseMessage(payload);
  if (!message) return;

  const db = createAdminClient();

  // Idempotency check — the insert (not this select) is the atomic guard, since
  // Meta can deliver the same webhook event twice in quick succession and two
  // concurrent requests can both pass this select before either insert lands.
  const { data: existing } = await db
    .from("processed_messages")
    .select("message_id")
    .eq("message_id", message.messageId)
    .single();
  if (existing) return;

  const { error: insertError } = await db
    .from("processed_messages")
    .insert({ message_id: message.messageId });
  if (insertError) return; // unique violation — another concurrent request already claimed this message_id

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
    .select("id, name, notes, first_message")
    .single();

  if (!customer) return;

  const customerId = customer.id;
  const { data: latestOrder } = await db
    .from("orders")
    .select("id, status")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const latestOrderStatus = latestOrder?.status ?? null;

  // NOTE: customer.name is never populated from the WhatsApp profile name here.
  // It is set only from the order form (extract_order) once the customer actually orders,
  // so contacts are not "renamed" / listed until they have ordered and paid.

  // Capture first message and detect ad creative tag on very first contact
  if (!customer.first_message && message.text) {
    const tag = message.text.match(/\[C(\d+)\]/i)?.[1];
    await db
      .from("customers")
      .update({
        first_message: message.text,
        ad_creative: tag ? `C${tag}` : null,
      })
      .eq("id", customerId);
  }

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

  // Meta deletes inbound media after roughly a week, so the bytes are copied
  // into our own storage now, at receipt time — a saved `media_id` alone rots.
  // Memoized because several save paths below ask for the same URL; lazy
  // because text messages and payment proofs (which store their own copy in
  // `payment-proofs`) must not pay for a download they never use.
  let storedMediaUrl: Promise<string | null> | undefined;
  const inboundMediaUrl = async (): Promise<string | undefined> => {
    const mediaId = mediaIdOf(message);
    if (!mediaId) return undefined;
    storedMediaUrl ??= storeInboundMedia({
      mediaId,
      customerId,
      mimeType:
        message.type === "image"
          ? message.imageMimeType
          : message.documentMimeType,
      filename:
        message.type === "document" ? message.documentFilename : undefined,
    });
    return (await storedMediaUrl) ?? undefined;
  };

  const { data: stateRow } = await db
    .from("customer_state")
    .select("state, menu_shown")
    .eq("customer_id", customerId)
    .single();

  // Check flags
  const { data: flags } = await db
    .from("customer_flags")
    .select(
      "escalated_to_human, is_blacklisted, pending_bot_response, pending_bot_question, last_human_activity_at",
    )
    .eq("customer_id", customerId)
    .single();

  if (flags?.is_blacklisted) return;

  // Hand the thread back inline, before the escalated branch swallows the
  // message. Admins forget to press "Resume bot", so threads stayed with a
  // human indefinitely and the customer talked to nobody. The auto-resume cron
  // also clears these, but only on its own schedule — resuming here means the
  // bot answers *this* message instead of the customer waiting for the sweep.
  const autoResumed =
    flags?.escalated_to_human === true &&
    shouldAutoResume(flags.last_human_activity_at);
  if (autoResumed) {
    await tryLearnCustomerContext(customerId, db);
    await db
      .from("customer_flags")
      .update({
        escalated_to_human: false,
        escalation_reason: null,
        last_human_activity_at: null,
      })
      .eq("customer_id", customerId);
    console.log(`[webhook] auto-resumed bot for ${customerId} on new message`);
  }

  if (flags?.escalated_to_human && !autoResumed) {
    const escalatedText =
      message.type === "text"
        ? (message.text ?? "")
        : message.type === "image"
          ? "[Image]"
          : message.type === "document"
            ? formatDocumentMessage(message)
            : message.type === "location"
              ? formatLocationMessage(message)
              : `[${message.type}]`;
    const escalatedIntent = await classifyIntent(escalatedText).catch(
      () => "other",
    );
    await saveMessage({
      customerId,
      role: "user",
      content: escalatedText,
      messageId: message.messageId,
      intent: escalatedIntent,
      messageType: mediaMessageType(message.type),
      mediaId: mediaIdOf(message),
      mediaUrl: await inboundMediaUrl(),
    });
    await tryLearnCustomerContext(customerId, db);
    // The push is unconditional. It used to sit in the `else`, so a plain text
    // message — the overwhelmingly common case — notified nobody: the bot is
    // silent on an escalated thread, so the admin who took it over was the only
    // one who could answer, and they were never told. analyzeCustomerMessage is
    // not a substitute; it only surfaces anything when it proposes a write.
    await sendPushToAllAdmins(
      "New message — you have this thread",
      `${customer.name ?? message.from}: ${escalatedText.slice(0, 80)}`,
      "/inbox",
      "high",
    );
    if (message.type === "text" && escalatedText.trim()) {
      analyzeCustomerMessage({
        customerId,
        customerName: customer.name ?? null,
        text: escalatedText,
      }).catch((err) =>
        console.error("[webhook] analyzeCustomerMessage failed:", err),
      );
    }
    await db
      .from("processed_messages")
      .update({ processed_at: new Date().toISOString() })
      .eq("message_id", message.messageId);
    return;
  }

  if (flags?.pending_bot_response) {
    const pendingText =
      message.type === "text"
        ? (message.text ?? "")
        : message.type === "image"
          ? "[Image]"
          : message.type === "document"
            ? formatDocumentMessage(message)
            : message.type === "location"
              ? formatLocationMessage(message)
              : `[${message.type}]`;
    const pendingIntent = await classifyIntent(pendingText).catch(
      () => "other",
    );
    await saveMessage({
      customerId,
      role: "user",
      content: pendingText,
      messageId: message.messageId,
      intent: pendingIntent,
      messageType: mediaMessageType(message.type),
      mediaId: mediaIdOf(message),
      mediaUrl: await inboundMediaUrl(),
    });
    await tryLearnCustomerContext(customerId, db);
    await sendPushToAllAdmins(
      "New message (awaiting bot reply)",
      `${message.from}: ${pendingText.slice(0, 80)}`,
      "/inbox",
      "medium",
    );
    await db
      .from("processed_messages")
      .update({ processed_at: new Date().toISOString() })
      .eq("message_id", message.messageId);
    return;
  }

  // Payment proof: capture image when the latest order is still pending payment
  if (message.type === "image" && message.imageId) {
    if (shouldHandlePaymentProof(latestOrderStatus)) {
      await handlePaymentProofImage(
        message,
        customerId,
        customer.name,
        message.from,
      );
      await db
        .from("processed_messages")
        .update({ processed_at: new Date().toISOString() })
        .eq("message_id", message.messageId);
      return;
    }

    if (!message.imageCaption) {
      await saveMessage({
        customerId,
        role: "user",
        content: "[Image]",
        messageId: message.messageId,
        intent: "other",
        messageType: "image",
        mediaId: message.imageId,
        mediaUrl: await inboundMediaUrl(),
      });
      const tmpl = await getTemplate("text_only");
      await sendTextMessage(message.from, tmpl);
      await db
        .from("processed_messages")
        .update({ processed_at: new Date().toISOString() })
        .eq("message_id", message.messageId);
      return;
    }
  }

  // Documents (PDF etc.): save so they show in the inbox, then ask for text
  if (message.type === "document" && message.documentId) {
    await saveMessage({
      customerId,
      role: "user",
      content: formatDocumentMessage(message),
      messageId: message.messageId,
      intent: "other",
      messageType: "document",
      mediaId: message.documentId,
      mediaUrl: await inboundMediaUrl(),
    });
    const tmpl = await getTemplate("text_only");
    await sendTextMessage(message.from, tmpl);
    await db
      .from("processed_messages")
      .update({ processed_at: new Date().toISOString() })
      .eq("message_id", message.messageId);
    return;
  }

  // Non-text messages
  let text: string;
  if (message.type === "location") {
    text = formatLocationMessage(message);
  } else if (message.type === "image" && message.imageCaption) {
    text = message.imageCaption;
  } else if (message.type !== "text") {
    const tmpl = await getTemplate("text_only");
    await sendTextMessage(message.from, tmpl);
    return;
  } else {
    text = message.text ?? "";
  }

  // Haiku classification + save customer message now so it always appears in inbox,
  // even when rate limit / injection / circuit breaker cut the flow short below.
  const intent = await classifyIntent(text).catch(() => "other");
  await saveMessage({
    customerId,
    role: "user",
    content: text,
    messageId: message.messageId,
    intent,
    messageType: message.type === "image" ? "image" : "text",
    mediaId: message.type === "image" ? message.imageId : undefined,
    mediaUrl: await inboundMediaUrl(),
  });
  const normalizedCustomerState = normalizeCustomerState(stateRow?.state);
  if (
    intent === "ordering" &&
    normalizedCustomerState !== "ordering" &&
    !hasCurrentOrder(latestOrderStatus)
  ) {
    await db
      .from("customer_state")
      .update({ state: "ordering", updated_at: new Date().toISOString() })
      .eq("customer_id", customerId);
  }

  const learnedNotes = await tryLearnCustomerContext(customerId, db);

  // No rate limit check here. checkRateLimit() increments the counter as a side
  // effect, and processSavedCustomerMessage() below always runs it too, so a
  // check at this point charged every inbound message twice and turned the
  // 20/day cap into an effective 10. That one gates the Sonnet call itself and
  // is also the only gate on the replay-latest path, so it is the one to keep.

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

  // Load history
  const history = await loadHistory(customerId);

  // Customer state
  // Casual mode coin flip
  const casualProbRaw = await getSetting("casual_mode_probability");
  const casualProb = Number.parseFloat(casualProbRaw) || 0.5;
  const _casual = Math.random() < casualProb;

  // Detect Maps link in current message or history so we can inject it explicitly
  const mapsLinkRegex =
    /https?:\/\/(?:maps\.app\.goo\.gl|maps\.google\.com\/maps|goo\.gl\/maps)\S*/;
  let detectedMapsLink: string | null = text.match(mapsLinkRegex)?.[0] ?? null;
  if (!detectedMapsLink) {
    for (const msg of history) {
      if (msg.role !== "user") continue;
      const msgText = Array.isArray(msg.content)
        ? msg.content
            .map((b) => (typeof b === "object" && "text" in b ? b.text : ""))
            .join(" ")
        : String(msg.content);
      const found = msgText.match(mapsLinkRegex)?.[0];
      if (found) {
        detectedMapsLink = found;
        break;
      }
    }
  }

  // Send welcome sequence on first contact — atomic claim prevents duplicate sends
  // when two messages arrive before the first one sets menu_shown = true.
  // Skip entirely if the customer already has an order (e.g. legacy-imported
  // customers whose customer_state row never got menu_shown set) — they go
  // straight to Claude, which treats them as a returning customer.
  if (!stateRow?.menu_shown && !latestOrderStatus) {
    const { data: claimed } = await db
      .from("customer_state")
      .update({ menu_shown: true })
      .eq("customer_id", customerId)
      .or("menu_shown.is.null,menu_shown.eq.false")
      .select("customer_id");

    if (claimed && claimed.length > 0) {
      const [
        welcomeText,
        priceListUrl,
        deadlineHour,
        { data: welcomeSubs },
        { data: tier20 },
      ] = await Promise.all([
        getSetting("welcome_message"),
        getSetting("price_list_image_url"),
        getSetting("order_deadline_hour"),
        db
          .from("subcontractors")
          .select("customer_nickname, menu_image_url, delivery_areas")
          .eq("is_active", true)
          .not("menu_image_url", "is", null),
        db
          .from("pricing_tiers")
          .select("price_per_portion")
          .eq("portions", 20)
          .maybeSingle(),
      ]);

      const activeDapurs = (welcomeSubs ?? []).filter(
        (s) => s.customer_nickname,
      );
      const n = activeDapurs.length;
      const dapurListText =
        n === 0
          ? ""
          : n === 1
            ? `Kami ada 1 dapur dengan 1 menu:\n• ${activeDapurs[0].customer_nickname}`
            : `Kami ada ${n} dapur dengan ${n} menu berbeda:\n${activeDapurs.map((s) => `• ${s.customer_nickname}`).join("\n")}`;

      const uniqueAreas = [
        ...new Set(
          activeDapurs.flatMap(
            (s) =>
              (s as { delivery_areas?: string[] | null }).delivery_areas ?? [],
          ),
        ),
      ].sort();
      const areasText =
        uniqueAreas.length <= 1
          ? (uniqueAreas[0] ?? "")
          : `${uniqueAreas.slice(0, -1).join(", ")}, dan ${uniqueAreas[uniqueAreas.length - 1]}`;

      const price20Text = tier20
        ? `${Math.round(tier20.price_per_portion / 1000)}RB`
        : "";
      const deadlineText = deadlineHour ? `${deadlineHour}.00` : "";

      const resolvedWelcome =
        (welcomeText ?? "")
          .replace("{{dapur_list}}", dapurListText)
          .replace("{{delivery_areas}}", areasText)
          .replace("{{price_20}}", price20Text)
          .replace("{{order_deadline}}", deadlineText)
          .trim() || dapurListText;

      // Save the incoming message first so it sorts before the welcome replies.
      await saveMessage({
        customerId,
        role: "user",
        content: text,
        messageId: message.messageId,
        intent,
        messageType: message.type === "image" ? "image" : "text",
        mediaId: message.type === "image" ? message.imageId : undefined,
        mediaUrl: await inboundMediaUrl(),
      });
      await tryLearnCustomerContext(customerId, db);

      // Send welcome sequence and log each outbound message to the inbox so the
      // greeting and menu images are visible in the dashboard conversation view.
      if (resolvedWelcome) {
        const conversationId = await saveMessage({
          customerId,
          role: "assistant",
          content: resolvedWelcome,
          modelUsed: "system",
        });
        const whatsappMessageId = await sendTextMessage(
          message.from,
          resolvedWelcome,
        );
        await updateMessageReceipt({
          conversationId,
          whatsappMessageId,
          status: "sent",
        });
      }
      if (priceListUrl) {
        try {
          const conversationId = await saveMessage({
            customerId,
            role: "assistant",
            content: priceListUrl,
            messageType: "image",
            modelUsed: "system",
          });
          const whatsappMessageId = await sendImageByUrl(
            message.from,
            priceListUrl,
            "Harga & Area Pengiriman",
          );
          await updateMessageReceipt({
            conversationId,
            whatsappMessageId,
            status: "sent",
          });
        } catch (e) {
          console.error(
            "[welcome] price list send failed — url:",
            priceListUrl?.slice(0, 120),
            "error:",
            e,
          );
        }
      }
      for (const sub of welcomeSubs ?? []) {
        if (sub.menu_image_url) {
          try {
            const conversationId = await saveMessage({
              customerId,
              role: "assistant",
              content: sub.menu_image_url,
              messageType: "image",
              modelUsed: "system",
            });
            const whatsappMessageId = await sendImageByUrl(
              message.from,
              sub.menu_image_url,
              sub.customer_nickname
                ? `Menu ${sub.customer_nickname}`
                : "Menu Dapur",
            );
            await updateMessageReceipt({
              conversationId,
              whatsappMessageId,
              status: "sent",
            });
          } catch (e) {
            console.error("[welcome] menu image send failed:", e);
          }
        }
      }

      const tnc = [
        "*Syarat & Ketentuan Pian Yi Catering:*",
        "",
        `📦 Setiap porsi: nasi + lauk + sayur + sambal (mika bento)`,
        `🚚 Pengiriman siang 10.00–12.00 WIB | malam 16.00–18.00 WIB`,
        `⏰ Batas order & perubahan: jam ${deadlineText} H-1 pengiriman`,
        `💰 Pembayaran di muka sebelum jam ${deadlineText}`,
        `⚠️ Terlambat (siang >12.30 / malam >18.30) → diskon 50%`,
        `🏠 Pesanan selalu digantung di pintu/pagar — kurir tidak menunggu`,
        `📅 Tutup di semua hari libur nasional (tanggal merah)`,
        `🚫 Pembayaran tidak dapat di-refund`,
        "",
        "Dengan melanjutkan pemesanan, kak menyetujui ketentuan di atas 🙏",
      ].join("\n");
      try {
        const conversationId = await saveMessage({
          customerId,
          role: "assistant",
          content: tnc,
          modelUsed: "system",
        });
        const whatsappMessageId = await sendTextMessage(message.from, tnc);
        await updateMessageReceipt({
          conversationId,
          whatsappMessageId,
          status: "sent",
        });
      } catch (e) {
        console.error("[welcome] tnc send failed:", e);
      }

      // Its own bubble, last in the welcome sequence. See
      // src/lib/whatsapp/window-notice.ts for why this exists.
      const windowNotice = WINDOW_NOTICE_WELCOME;
      try {
        const conversationId = await saveMessage({
          customerId,
          role: "assistant",
          content: windowNotice,
          modelUsed: "system",
        });
        const whatsappMessageId = await sendTextMessage(
          message.from,
          windowNotice,
        );
        await updateMessageReceipt({
          conversationId,
          whatsappMessageId,
          status: "sent",
        });
      } catch (e) {
        console.error("[welcome] 24h window notice send failed:", e);
      }
    }
  }

  await processSavedCustomerMessage({
    customerId,
    customerName: customer.name,
    customerNotes: learnedNotes ?? customer.notes,
    latestOrderStatus,
    phone: message.from,
    stateRow,
    text,
    messageId: message.messageId,
    coalesceBurst: true,
  });

  // Mark processed
  await db
    .from("processed_messages")
    .update({ processed_at: new Date().toISOString() })
    .eq("message_id", message.messageId);
}

export async function processSavedCustomerMessage(params: {
  customerId: string;
  customerName: string | null;
  customerNotes: string | null;
  latestOrderStatus?: string | null;
  phone: string;
  stateRow:
    | {
        state: string | null;
        menu_shown: boolean | null;
      }
    | null
    | undefined;
  text: string;
  messageId?: string | null;
  // Draft mode: generate the reply, send nothing, save nothing, run no tools,
  // and hand the text back so an admin can edit it before it goes out. Every
  // side effect on this path is irreversible from the customer's side, so the
  // rule is simple — in draft mode the only thing that happens is the model
  // call. Returns the draft text; normal mode always returns null.
  draft?: boolean;
  // Hold this message for BURST_WINDOW_MS and drop it if the customer sends
  // another one meanwhile. Only the live webhook sets this; an admin asking for
  // a replay or a draft wants an answer to the message they picked, now.
  coalesceBurst?: boolean;
}): Promise<string | null> {
  const {
    customerId,
    customerName,
    customerNotes,
    latestOrderStatus,
    phone,
    stateRow,
    text,
    messageId,
    draft = false,
    coalesceBurst = false,
  } = params;
  const db = createAdminClient();

  // Customers type the way they talk: four messages in twenty seconds, one
  // thought each. The webhook treats every inbound message as its own turn, so
  // Cindy's four-message complaint on 13 Aug drew four separate apologies, each
  // its own model call. The echo guard could not catch it — it compares reply
  // text exactly, and four differently-worded apologies are not equal strings.
  //
  // So hold the message briefly and drop it if a newer one arrives: the last
  // message of a burst is the one that answers, and because history loads
  // further down (after this wait) that surviving call sees the whole burst and
  // writes one reply covering all of it. Costs every reply this much latency,
  // which reads as human on WhatsApp, and cuts a burst's model spend to one call.
  if (coalesceBurst && messageId) {
    await sleep(BURST_WINDOW_MS);
    const { data: newest } = await db
      .from("conversations")
      .select("message_id")
      .eq("customer_id", customerId)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (newest?.message_id && newest.message_id !== messageId) {
      console.log(
        `[webhook] ${messageId} superseded by ${newest.message_id}, no reply`,
      );
      return null;
    }
  }

  // Rate limit check. Must stay above analyzeCustomerMessage: that is a Haiku
  // call, and a rate-limited customer should not cost a model call at all.
  if (!draft && !shouldHandlePaymentProof(latestOrderStatus)) {
    const rateCheck = await checkRateLimit(customerId);
    if (!rateCheck.allowed) {
      const tmpl = await getTemplate("rate_limit_exceeded");
      await sendTextMessage(phone, tmpl);
      await sendPushToAllAdmins(
        "Rate limit hit",
        `${phone} hit ${rateCheck.reason}`,
        "/inbox",
        "medium",
      );
      return null;
    }
  }

  // Skipped when drafting: this is a second Sonnet call that can open an
  // assistant thread and push every admin. An admin asking for a draft has
  // already read the message, and re-drafting three times should not raise
  // three alerts.
  if (!draft && text.trim()) {
    analyzeCustomerMessage({ customerId, customerName, text }).catch((err) =>
      console.error("[webhook] analyzeCustomerMessage failed:", err),
    );
  }

  // No "new message" push here: processWebhookAsync already sent one before
  // handing off, and replay-latest re-runs this function over a message the
  // admin is already looking at. Both cases would notify about nothing new.

  // Prompt injection
  if (detectInjection(text)) {
    if (!draft) {
      const tmpl = await getTemplate("chatbot_unavailable");
      await sendTextMessage(phone, tmpl);
    }
    await db
      .from("customer_flags")
      .update({ is_suspicious: true })
      .eq("customer_id", customerId);
    return null;
  }

  // Circuit breaker check
  if (isCircuitOpen()) {
    if (!draft) {
      const tmpl = await getTemplate("chatbot_unavailable");
      await sendTextMessage(phone, tmpl);
    }
    return null;
  }

  // Load history
  const history = await loadHistory(customerId);

  // Customer state
  // Casual mode coin flip
  const casualProbRaw = await getSetting("casual_mode_probability");
  const casualProb = Number.parseFloat(casualProbRaw) || 0.5;
  const casual = Math.random() < casualProb;

  // Detect Maps link in current message or history so we can inject it explicitly
  const mapsLinkRegex =
    /https?:\/\/(?:maps\.app\.goo\.gl|maps\.google\.com\/maps|goo\.gl\/maps)\S*/;
  let detectedMapsLink: string | null = text.match(mapsLinkRegex)?.[0] ?? null;
  if (!detectedMapsLink) {
    for (const msg of history) {
      if (msg.role !== "user") continue;
      const msgText = Array.isArray(msg.content)
        ? msg.content
            .map((b) => (typeof b === "object" && "text" in b ? b.text : ""))
            .join(" ")
        : String(msg.content);
      const found = msgText.match(mapsLinkRegex)?.[0];
      if (found) {
        detectedMapsLink = found;
        break;
      }
    }
  }

  // Load active dapurs and active order quota in parallel
  const [{ data: activeSubs }, { data: activeOrderRow }] = await Promise.all([
    db
      .from("subcontractors")
      .select(
        "id, customer_nickname, menu_image_url, menu_text, menu_week_start, delivery_areas",
      )
      .eq("is_active", true)
      .not("customer_nickname", "is", null),
    db
      .from("orders")
      .select(
        "id, portions_remaining, package_size, portions_per_delivery, meal_time_preference",
      )
      .eq("customer_id", customerId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const rawSubs = (activeSubs ?? []).filter(
    (
      s,
    ): s is {
      id: string;
      customer_nickname: string;
      menu_image_url: string | null;
      menu_text: string | null;
      menu_week_start: string | null;
      delivery_areas: string[] | null;
    } => s.customer_nickname !== null,
  );
  // Only offer a dapur if its menu image has been uploaded
  const dapurOptions = rawSubs
    .filter((s) => !!s.menu_image_url)
    .map((s) => ({ id: s.id, nickname: s.customer_nickname }));
  const dapurMenuTexts = rawSubs
    .filter((s) => !!s.menu_image_url && !!s.menu_text)
    .map((s) => ({
      nickname: s.customer_nickname,
      menuText: s.menu_text as string,
    }));
  const servedAreas = [
    ...new Set(rawSubs.flatMap((s) => s.delivery_areas ?? [])),
  ].sort();
  const neighborhoods = await getNeighborhoods();
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
    customerName,
    customerNotes,
    detectedMapsLink,
    menuShown: stateRow?.menu_shown ?? false,
    dapurOptions,
    dapurMenuTexts,
    // Only the kitchens whose image can actually be sent decide the week.
    menuWeek: describeMenuWeeks(
      rawSubs.filter((s) => !!s.menu_image_url).map((s) => s.menu_week_start),
    ),
    servedAreas,
    neighborhoods,
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
            description:
              "UUID of the chosen dapur (from the dapur ID mapping in the system prompt)",
          },
          size: {
            type: "string",
            enum: ["s"],
            description:
              "Package size. Current customer-facing chatbot orders must use s; do not ask the customer about M.",
          },
        },
        required: [
          "customer_name",
          "package_size",
          "portions_per_delivery",
          "address",
          "maps_link",
          "area",
          "size",
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
            description:
              "ISO date string YYYY-MM-DD — the requested delivery date (tomorrow unless customer specifies otherwise)",
          },
          meal_type: {
            type: "string",
            enum: ["lunch", "dinner", "both"],
          },
          portions: {
            type: "number",
            description:
              "Total portions to deduct from quota (e.g. 2 for 1-portion keduanya order — 1 lunch + 1 dinner)",
          },
          notes: { type: "string" },
        },
        required: ["delivery_date", "meal_type", "portions"],
      },
    },
    {
      name: "ask_admin_for_help",
      description:
        "Called when the bot is uncertain about the answer. Pauses the bot, asks Annie for input, then the bot will send a polished version of Annie's answer to the customer. Use this by default for uncertainty. Do NOT use escalate_to_human unless the customer needs a human to take over entirely.",
      input_schema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The customer's question or the situation the bot is unsure about",
          },
        },
        required: ["question"],
      },
    },
    {
      name: "escalate_to_human",
      description:
        "Called when the conversation must be fully handed off to Annie — use only for complaints, refund requests, or clearly frustrated customers.",
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
    {
      name: "send_menu_image",
      description:
        "Sends the menu image(s) currently on file. Which week those cover is stated in your system prompt — check it before you describe what you are sending, and do not claim a week the prompt does not say you have. Safe to call even if the menu was previously sent.",
      input_schema: { type: "object", properties: {} },
    },
  ];

  // Call Sonnet 4.6 (with one retry on overload)
  let claudeResponse: Anthropic.Messages.Message;
  try {
    const client = getAnthropicClient();
    const callClaude = () =>
      client.messages.create({
        model: SONNET_MODEL,
        ...NO_THINKING,
        max_tokens: 1000,
        system: systemPrompt,
        messages: [...history, { role: "user", content: text }],
        // No tools when drafting. Every tool here writes something the customer
        // sees or the books record (create_order, send_menu_image), and a draft
        // the admin then discards must leave nothing behind. Without tools the
        // model always answers in text, which is what the compose box needs.
        ...(draft ? {} : { tools }),
      });
    try {
      claudeResponse = await callClaude();
    } catch (firstErr) {
      const msg = (firstErr as Error).message;
      if (
        !msg.includes("overloaded") &&
        !msg.includes("529") &&
        !msg.includes("too busy") &&
        !msg.includes("503")
      )
        throw firstErr;
      await new Promise((r) => setTimeout(r, 2000));
      claudeResponse = await callClaude();
    }
    recordSuccess();
  } catch (err) {
    console.error("[webhook] Claude API error:", (err as Error).message);
    await recordFailure();
    sendPushToAllAdmins(
      "Claude API error",
      (err as Error).message.slice(0, 100),
      "/inbox",
      "high",
    ).catch(console.error);
    if (!draft) {
      const tmpl = await getTemplate("chatbot_unavailable");
      await sendTextMessage(phone, tmpl);
    }
    return null;
  }

  // Extract text reply and tool use
  let replyText = "";
  let toolUse: Anthropic.Messages.ToolUseBlock | null = null;

  for (const block of claudeResponse.content) {
    if (block.type === "text") replyText = block.text;
    if (block.type === "tool_use") toolUse = block;
  }

  if (draft) {
    const text = extractText(claudeResponse);
    if (!text) {
      console.error(
        "[webhook] empty draft, stop_reason:",
        claudeResponse.stop_reason,
        "block types:",
        claudeResponse.content.map((b) => b.type).join(","),
      );
    }
    return text || null;
  }

  if (!replyText && !toolUse) {
    console.error(
      "[webhook] no text and no tool_use, stop_reason:",
      claudeResponse.stop_reason,
      "block types:",
      claudeResponse.content.map((b) => b.type).join(","),
    );
    await sendPushToAllAdmins(
      "Bot produced no reply",
      `${customerName ?? phone} — stop_reason ${claudeResponse.stop_reason}`,
      "/inbox",
      "high",
    ).catch(console.error);
    return null;
  }

  // Run the tool before asking for the accompanying text, so the follow-up call
  // below can report the real result back to the model.
  if (toolUse) {
    await handleToolUse(toolUse, customerId, phone, customerName);
  }

  // A tool call with no text alongside it. Anthropic models answer and call a
  // tool in the same response, so one round trip was enough; a reasoning model
  // spends the turn on `thinking` + `tool_use` and emits no text, which left the
  // customer with total silence whenever the tool was a no-op (Julie W got
  // send_menu_image on an already-sent menu). Feed the tool result back and ask
  // for the reply that should have come with it.
  if (toolUse && !replyText) {
    try {
      const client = getAnthropicClient();
      const followUp = await client.messages.create({
        model: SONNET_MODEL,
        ...NO_THINKING,
        max_tokens: 1000,
        system: systemPrompt,
        messages: [
          ...history,
          { role: "user", content: text },
          { role: "assistant", content: claudeResponse.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: toolUse.id,
                content: "done",
              },
            ],
          },
        ],
        tools,
      });
      replyText = extractText(followUp);
      await updateTokenCount(
        customerId,
        followUp.usage.input_tokens + followUp.usage.output_tokens,
      );
    } catch (err) {
      console.error(
        "[webhook] tool follow-up call failed:",
        (err as Error).message,
      );
    }
  }

  let replyConversationId: string | null = null;

  // Echo detection
  if (replyText) {
    const isEcho = await detectEcho(customerId, replyText);
    if (isEcho) {
      console.warn("[webhook] echo detected for customer", customerId);
      await sendPushToAllAdmins(
        "Echo detected",
        `Customer ${phone}`,
        "/inbox",
        "medium",
      );
      return null;
    }
  }

  let replyModelUsed = "sonnet-4-6";

  if (replyText) {
    const validationParams = {
      customerName,
      customerNotes,
      customerState: stateRow?.state ?? "new",
      activeOrder: activeOrder
        ? {
            portionsRemaining: activeOrder.portionsRemaining,
            packageSize: activeOrder.packageSize,
          }
        : null,
    };
    const validation = await validateReply({
      reply: replyText,
      ...validationParams,
    });

    if (!validation.valid) {
      console.warn(
        "[webhook] reply validator rejected first attempt:",
        validation.unsupportedClaims,
      );

      let retryText = "";
      try {
        const client = getAnthropicClient();
        const retryResponse = await client.messages.create({
          model: SONNET_MODEL,
          ...NO_THINKING,
          max_tokens: 1000,
          system: systemPrompt,
          messages: [
            ...history,
            { role: "user", content: text },
            { role: "assistant", content: replyText },
            {
              role: "user",
              content: `Balasan sebelumnya berisi klaim yang tidak didukung data: ${validation.unsupportedClaims.join(", ")}. Tulis ulang balasan tanpa menebak — hanya gunakan fakta dari Current context di system prompt. Jika data tidak tersedia, katakan akan dicek dulu.`,
            },
          ],
          tools,
        });
        for (const block of retryResponse.content) {
          if (block.type === "text") retryText = block.text;
        }
        await updateTokenCount(
          customerId,
          retryResponse.usage.input_tokens + retryResponse.usage.output_tokens,
        );
      } catch (err) {
        console.error(
          "[webhook] regeneration after validator rejection failed:",
          (err as Error).message,
        );
      }

      const revalidation = retryText
        ? await validateReply({ reply: retryText, ...validationParams })
        : { valid: false, unsupportedClaims: ["empty or failed regeneration"] };

      if (revalidation.valid && retryText) {
        replyText = retryText;
      } else {
        console.warn(
          "[webhook] reply validator rejected second attempt, falling back:",
          revalidation.unsupportedClaims,
        );
        replyText = await getTemplate("reply_validation_fallback");
        replyModelUsed = "system";
        await db
          .from("customer_flags")
          .update({
            pending_bot_response: true,
            pending_bot_question:
              "Auto-flagged: bot reply blocked twice by hallucination validator, needs review",
          })
          .eq("customer_id", customerId);
        await sendPushToAllAdmins(
          "Reply blocked — possible hallucination",
          `${customerName ?? phone}: ${validation.unsupportedClaims.join(", ")}`,
          "/inbox",
          "high",
        );
      }
    }

    // Language guard. The validator above only checks invented facts, so an
    // English reply used to ship as-is. Runs after it so a reply that was
    // rewritten or replaced is the one that gets checked.
    if (looksEnglish(replyText)) {
      console.warn("[webhook] reply was English, translating:", replyText);
      const translated = await translateToIndonesian(replyText);
      if (translated) replyText = translated;
    }

    // Last, so it also cleans up a validator retry or a translated reply. Saved
    // in its cleaned form too — the inbox must show what the customer got.
    replyText = sanitizeReply(replyText);

    const savedReplyId = await saveMessage({
      customerId,
      role: "assistant",
      content: replyText,
      modelUsed: replyModelUsed,
      inputTokens: claudeResponse.usage.input_tokens,
      outputTokens: claudeResponse.usage.output_tokens,
    });
    replyConversationId = savedReplyId;
  }

  // Update token count
  await updateTokenCount(
    customerId,
    claudeResponse.usage.input_tokens + claudeResponse.usage.output_tokens,
  );

  // Tool already handled above, before the follow-up call that needs its result.

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

    if (messageId) {
      await sendTypingIndicator(phone, messageId);
    }
    await sleep(delay);
    const whatsappMessageId = await sendTextMessage(phone, replyText);
    await updateMessageReceipt({
      conversationId: replyConversationId,
      whatsappMessageId,
      status: "sent",
    });
  }

  return null;
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
      console.error(
        "[webhook] failed to download media:",
        (err as Error).message,
      );
      return;
    }

    // Upload to Supabase Storage
    const today = new Date().toISOString().slice(0, 10);
    const storagePath = `${subcontractorId}/${today}/${message.messageId}.jpg`;
    const { error: uploadErr } = await db.storage
      .from("delivery-proofs")
      .upload(storagePath, imageBuffer, {
        contentType: "image/jpeg",
        upsert: false,
      });

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
        .upload(storagePath, imageBuffer, {
          contentType: "image/jpeg",
          upsert: false,
        });
      if (!uploadErr) {
        const { data: urlData } = db.storage
          .from("payment-proofs")
          .getPublicUrl(storagePath);
        imageUrl = urlData.publicUrl;
      } else {
        console.error(
          "[webhook] payment proof upload failed:",
          uploadErr.message,
        );
      }
    } catch (err) {
      console.error(
        "[webhook] payment proof download failed:",
        (err as Error).message,
      );
    }
  }

  await db
    .from("orders")
    .update({ status: "payment_proof_received", payment_proof_url: imageUrl })
    .eq("customer_id", customerId)
    .eq("status", "pending_payment");

  await saveMessage({
    customerId,
    role: "user",
    content: imageUrl ?? "[Bukti pembayaran dikirim]",
    messageId: message.messageId,
    messageType: "image",
    mediaId: imageUrl ? undefined : (message.imageId ?? undefined),
  });
  await tryLearnCustomerContext(customerId, db);

  const confirmMsg =
    "Terima kasih kak! Bukti pembayaran sudah kami terima ya. Kami akan segera memverifikasi pembayaranmu dan menghubungimu kembali.";
  const conversationId = await saveMessage({
    customerId,
    role: "assistant",
    content: confirmMsg,
    modelUsed: "human",
  });
  const whatsappMessageId = await sendTextMessage(phone, confirmMsg);
  await updateMessageReceipt({
    conversationId,
    whatsappMessageId,
    status: "sent",
  });

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
    await createOrderFromExtraction(
      customerId,
      phone,
      tool.input as ExtractedOrderInput,
    );
  } else if (tool.name === "record_daily_order") {
    const input = tool.input as {
      delivery_date: string;
      meal_type: "lunch" | "dinner" | "both";
      portions: number;
      notes?: string;
    };

    // Prefer the order whose meal_time_preference matches the requested meal type.
    // Falls back to newest active order for customers with a single combined order.
    const mealPrefs: Record<"lunch" | "dinner" | "both", string[]> = {
      lunch: [
        "lunch_only",
        "both_fixed",
        "per_day_decision",
        "default_lunch",
        "custom_schedule",
      ],
      dinner: [
        "dinner_only",
        "both_fixed",
        "per_day_decision",
        "default_dinner",
        "custom_schedule",
      ],
      both: [
        "lunch_only",
        "dinner_only",
        "both_fixed",
        "per_day_decision",
        "default_lunch",
        "default_dinner",
        "custom_schedule",
      ],
    };
    const { data: matchedOrder } = await db
      .from("orders")
      .select("id, portions_remaining, subcontractor_id")
      .eq("customer_id", customerId)
      .eq("status", "active")
      .in("meal_time_preference", mealPrefs[input.meal_type])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: fallbackOrder } = matchedOrder
      ? { data: null }
      : await db
          .from("orders")
          .select("id, portions_remaining, subcontractor_id")
          .eq("customer_id", customerId)
          .eq("status", "active")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
    const order = matchedOrder ?? fallbackOrder;

    if (!order) {
      console.error(
        "[webhook] record_daily_order: no active order for customer",
        customerId,
      );
      return;
    }

    if (order.portions_remaining <= 0) {
      console.warn(
        "[webhook] record_daily_order: quota exhausted for order",
        order.id,
      );
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
      .update({
        portions_remaining: Math.max(
          0,
          order.portions_remaining - input.portions,
        ),
      })
      .eq("id", order.id);

    const { data: custQuota } = await db
      .from("customers")
      .select("portions_remaining")
      .eq("id", customerId)
      .single();
    if (custQuota) {
      await db
        .from("customers")
        .update({
          portions_remaining: Math.max(
            0,
            custQuota.portions_remaining - input.portions,
          ),
        })
        .eq("id", customerId);
    }

    await sendPushToAllAdmins(
      `Order harian — ${customerName ?? phone}`,
      `${input.delivery_date} ${input.meal_type} × ${input.portions} porsi`,
      "/deliveries",
      "low",
    );
  } else if (tool.name === "ask_admin_for_help") {
    const input = tool.input as { question: string };
    await db
      .from("customer_flags")
      .update({
        pending_bot_response: true,
        pending_bot_question: input.question,
      })
      .eq("customer_id", customerId);

    await sendTextMessage(
      phone,
      "Mohon tunggu sebentar kak, kami sedang cek dulu ya 🙏",
    );

    await sendPushToAllAdmins(
      `Butuh jawaban — ${customerName ?? phone}`,
      input.question.slice(0, 120),
      "/inbox",
      "high",
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
  } else if (tool.name === "send_menu_image") {
    const { data: menuSubsRaw } = await db
      .from("subcontractors")
      .select("customer_nickname, menu_image_url")
      // Inactive kitchens keep their last menu_image_url forever, and nobody
      // refreshes it once they stop cooking. Without this filter the customer
      // got the live menu plus a months-old one from a kitchen we no longer use.
      .eq("is_active", true)
      .not("menu_image_url", "is", null);
    const menuSubs = (menuSubsRaw ?? []).filter((s) => !!s.menu_image_url);
    for (const sub of menuSubs) {
      const conversationId = await saveMessage({
        customerId,
        role: "assistant",
        content: sub.menu_image_url,
        messageType: "image",
        modelUsed: "system",
      });
      const whatsappMessageId = await sendImageByUrl(
        phone,
        sub.menu_image_url,
        sub.customer_nickname ? `Menu ${sub.customer_nickname}` : "Menu Dapur",
      );
      await updateMessageReceipt({
        conversationId,
        whatsappMessageId,
        status: "sent",
      });
    }
  }
}

export const dynamic = "force-dynamic";
