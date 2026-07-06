import { getSetting } from "@/lib/cache/settings";
import { getAnthropicClient, HAIKU_MODEL } from "@/lib/claude/client";
import { saveMessage, updateMessageReceipt } from "@/lib/claude/conversation";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  fetchAndUploadImage,
  sendImageTemplate,
  sendTextMessage,
} from "@/lib/whatsapp/client";

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
    .eq("delivery_date", today)
    .in("status", ["scheduled", "delivered_on_time", "delivered_late"]);
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
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text =
      res.content[0].type === "text" ? res.content[0].text.trim() : "{}";
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
    console.error(`[sendDeliveryPhotoToCustomer] no phone for customer ${customerId}`);
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
  const conversationId = await saveMessage({
    customerId,
    role: "assistant",
    content: proof.image_url,
    messageType: "image",
    modelUsed: "human",
  });
  const messageId = await sendImageTemplate(
    phone,
    "delivery_proof",
    mediaId,
    [],
  );
  await updateMessageReceipt({
    conversationId,
    whatsappMessageId: messageId,
    status: "sent",
  });

  // Prompt customer to reply so the 24h service window stays open for tomorrow's proof.
  await sendTextMessage(
    phone,
    "Makanan sudah sampai ya kak 😊 Balas *ok* kalau sudah diterima.",
  );
}
