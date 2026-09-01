import { getSetting } from "@/lib/cache/settings";
import {
  extractJson,
  getAnthropicClient,
  HAIKU_MODEL,
  NO_THINKING,
} from "@/lib/claude/client";
import { saveMessage, updateMessageReceipt } from "@/lib/claude/conversation";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { pickDeliveryForPhoto } from "@/lib/deliveries/windows";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  fetchAndUploadImage,
  sendImageMessageById,
  sendImageTemplate,
} from "@/lib/whatsapp/client";
import { windowIsOpen } from "@/lib/whatsapp/window";
import { WINDOW_NOTICE_CLAUSE } from "@/lib/whatsapp/window-notice";

interface DeliveryRow {
  id: string;
  customer_id: string;
  meal_type: string;
  customers: { name: string | null; phone_number: string; area: string } | null;
}

async function getTodayDeliveries(
  subcontractorId: string,
): Promise<DeliveryRow[]> {
  const db = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db
    .from("daily_deliveries")
    .select("id, customer_id, meal_type, customers(name, phone_number, area)")
    .eq("subcontractor_id", subcontractorId)
    .eq("delivery_date", today);
  return (data ?? []) as unknown as DeliveryRow[];
}

export async function matchDeliveryPhoto(proofId: string): Promise<void> {
  const db = createAdminClient();

  const { data: proof } = await db
    .from("delivery_proofs")
    .select("*")
    .eq("id", proofId)
    .single();

  if (!proof) return;

  const todayDeliveries = proof.subcontractor_id
    ? await getTodayDeliveries(proof.subcontractor_id)
    : [];

  if (!proof.caption || todayDeliveries.length === 0) {
    await db
      .from("delivery_proofs")
      .update({ status: "needs_review" })
      .eq("id", proofId);
    await sendPushToAllAdmins(
      "Delivery photo needs manual matching",
      proof.caption ? `Caption: ${proof.caption}` : "No caption",
      "/deliveries",
      "medium",
    );
    return;
  }

  const customerList = todayDeliveries
    .map(
      (d) =>
        `ID: ${d.customer_id} | Name: ${d.customers?.name ?? "unknown"} | Area: ${d.customers?.area ?? "unknown"}`,
    )
    .join("\n");

  const prompt = `You are matching a delivery photo to a customer.
Photo caption: "${proof.caption}"

Today's customers for this subcontractor:
${customerList}

Return JSON only: { "customer_id": "...", "confidence": 0.0-1.0, "reasoning": "..." }
If no match is confident, return { "customer_id": null, "confidence": 0, "reasoning": "..." }`;

  let match: {
    customer_id: string | null;
    confidence: number;
    reasoning: string;
  };
  try {
    const client = getAnthropicClient();
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      ...NO_THINKING,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = extractJson(res) || "{}";
    match = JSON.parse(text);
  } catch {
    await db
      .from("delivery_proofs")
      .update({ status: "needs_review" })
      .eq("id", proofId);
    return;
  }

  const thresholdRaw = await getSetting("photo_match_confidence_threshold");
  const threshold = Number.parseFloat(thresholdRaw) || 0.95;

  // Which delivery the photo is of, not just whose. Without it the sheet can
  // only tick a customer for the whole day, so on 2026-09-01 a lunch photo
  // ticked the dinner rows of the three customers who eat both meals.
  const matchedDelivery = match.customer_id
    ? pickDeliveryForPhoto(
        todayDeliveries.filter((d) => d.customer_id === match.customer_id),
        new Date(proof.received_at ?? Date.now()),
      )
    : null;

  if (match.confidence >= threshold && match.customer_id) {
    await sendDeliveryPhotoToCustomer(
      proofId,
      match.customer_id,
      todayDeliveries,
    );
    await db
      .from("delivery_proofs")
      .update({
        matched_customer_id: match.customer_id,
        matched_delivery_id: matchedDelivery?.id ?? null,
        match_confidence: match.confidence,
        match_method: "auto",
        status: "auto_sent",
        sent_to_customer_at: new Date().toISOString(),
        sent_by: "system",
      })
      .eq("id", proofId);
  } else if (match.confidence >= 0.7 && match.customer_id) {
    await db
      .from("delivery_proofs")
      .update({
        matched_customer_id: match.customer_id,
        matched_delivery_id: matchedDelivery?.id ?? null,
        match_confidence: match.confidence,
        match_method: "auto",
        status: "needs_review",
      })
      .eq("id", proofId);
    const suggested = todayDeliveries.find(
      (d) => d.customer_id === match.customer_id,
    );
    await sendPushToAllAdmins(
      "Delivery photo needs confirmation",
      `Suggested: ${suggested?.customers?.name ?? match.customer_id}`,
      "/deliveries",
      "medium",
    );
  } else {
    await db
      .from("delivery_proofs")
      .update({ status: "needs_review", match_confidence: match.confidence })
      .eq("id", proofId);
    await sendPushToAllAdmins(
      "Delivery photo could not be matched",
      proof.caption ?? "No caption",
      "/deliveries",
      "medium",
    );
  }
}

export async function sendDeliveryPhotoToCustomer(
  proofId: string,
  customerId: string,
  deliveries?: DeliveryRow[],
  // Set when an admin pressed Send on the Proofs screen. Left undefined by the
  // automatic matcher, which is the bot acting on its own.
  sentBy?: string,
): Promise<void> {
  const db = createAdminClient();

  let rows = deliveries;
  if (!rows) {
    const { data: proof } = await db
      .from("delivery_proofs")
      .select("subcontractor_id")
      .eq("id", proofId)
      .single();
    rows = proof?.subcontractor_id
      ? await getTodayDeliveries(proof.subcontractor_id)
      : [];
  }

  const delivery = rows.find((d) => d.customer_id === customerId);

  let phone = delivery?.customers?.phone_number;
  if (!phone) {
    const { data: customer } = await db
      .from("customers")
      .select("phone_number")
      .eq("id", customerId)
      .single();
    phone = customer?.phone_number ?? undefined;
  }

  if (!phone) {
    console.error(
      `[sendDeliveryPhotoToCustomer] no phone for customer ${customerId}`,
    );
    return;
  }

  const { data: proof } = await db
    .from("delivery_proofs")
    .select("image_url")
    .eq("id", proofId)
    .single();

  if (!proof?.image_url) return;

  const storagePath = proof.image_url.split("/delivery-proofs/")[1];
  if (!storagePath) return;

  const { data: signedData } = await db.storage
    .from("delivery-proofs")
    .createSignedUrl(storagePath, 600); // 10 min — enough for WhatsApp to fetch

  if (!signedData?.signedUrl) return;

  const mediaId = await fetchAndUploadImage(signedData.signedUrl);

  // Prompt the customer to reply so the 24h window stays open for tomorrow's
  // proof. The ask was always here; the reason was not, so customers read the
  // silence that followed a missed reply as us ignoring them.
  const caption = `Makanan sudah sampai ya kak 😊 Balas *ok* kalau sudah diterima, ${WINDOW_NOTICE_CLAUSE}.`;

  // Inside the window the photo carries its own caption, as one message. It
  // used to go as a template with an image header and no body, followed by the
  // caption as a separate free-form text — so a customer received a bare photo
  // with no word about what it was, and the sentence explaining it either
  // arrived detached or, out of the window, not at all. The template is still
  // the only shape that can leave the window, so it stays for that case, and a
  // closed window is exactly where the follow-up text would be rejected anyway.
  const open = await windowIsOpen(customerId);

  const conversationId = await saveMessage({
    customerId,
    role: "assistant",
    // Caption in `content`, file in `media_url` — the shape
    // `/api/inbox/manual-image` writes and `getInboxDocument` reads. The URL
    // used to sit in `content` with no caption anywhere, which is why the
    // inbox drew the photo and none of the words that went with it.
    content: open ? caption : "[Foto pengiriman]",
    mediaUrl: proof.image_url,
    messageType: "image",
    modelUsed: "human",
    sentBy: sentBy ?? null,
  });

  const messageId = open
    ? await sendImageMessageById(phone, mediaId, caption)
    : await sendImageTemplate(phone, "delivery_proof", mediaId, []);

  await updateMessageReceipt({
    conversationId,
    whatsappMessageId: messageId,
    status: "sent",
  });
}
