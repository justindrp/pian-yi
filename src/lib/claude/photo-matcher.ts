import { logEdit, systemActor } from "@/lib/audit/log-edit";
import { getSetting } from "@/lib/cache/settings";
import {
  extractJson,
  getAnthropicClient,
  HAIKU_MODEL,
  NO_THINKING,
} from "@/lib/claude/client";
import { saveMessage, updateMessageReceipt } from "@/lib/claude/conversation";
import { proofRecipientsFor } from "@/lib/customers/proof-contacts";
import { pickDeliveryForPhoto } from "@/lib/deliveries/windows";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  fetchAndUploadImage,
  sendImageMessageById,
  sendImageTemplate,
} from "@/lib/whatsapp/client";
import { hoursSinceInbound, WINDOW_HOURS } from "@/lib/whatsapp/window";
import { WINDOW_NOTICE_CLAUSE } from "@/lib/whatsapp/window-notice";
import { askVision } from "./vision";

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

/** Bytes of a stored proof image, or null — a fetch failure falls back to the
 *  caption-only match that predates vision. */
async function fetchProofImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
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

  // The photo itself is evidence now, so a missing caption is no longer the end
  // of the road — a kitchen that photographs the label on the box says who it
  // is for without typing it. Nothing to match against is still the end.
  const imageBytes = proof.image_url
    ? await fetchProofImage(proof.image_url as string)
    : null;

  if ((!proof.caption && !imageBytes) || todayDeliveries.length === 0) {
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
${
  proof.caption
    ? `Photo caption: "${proof.caption}"`
    : "The photo has no caption. Read any name, label, unit number or handwriting visible in the image."
}

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
    let text: string;
    if (imageBytes) {
      const raw = await askVision({
        image: imageBytes,
        prompt,
        maxTokens: 1000,
      });
      text =
        (raw ?? "")
          .replace(/^```(?:json)?\n?/, "")
          .replace(/\n?```$/, "")
          .trim() || "{}";
    } else {
      const client = getAnthropicClient();
      const res = await client.messages.create({
        model: HAIKU_MODEL,
        ...NO_THINKING,
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      });
      text = extractJson(res) || "{}";
    }
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

/**
 * The caption on a pushed proof. It asks for a reply because the reply is what
 * keeps tomorrow's window open; the reason rides along because customers read
 * the silence after a missed reply as us ignoring them.
 */
const PROOF_CAPTION = `Makanan sudah sampai ya kak 😊 Balas *ok* kalau sudah diterima, ${WINDOW_NOTICE_CLAUSE}.`;

/** One photo, handed to WhatsApp for one number. */
export type ProofSend = {
  /** The buyer, or one of the recipients they registered. */
  owner: boolean;
  name: string | null;
  phone: string;
  /** Hours since that number last wrote to us; Infinity if it never has. */
  hours: number;
};

/** The image uploaded to WhatsApp once, ready to address at several numbers. */
async function proofMedia(
  proofId: string,
): Promise<{ mediaId: string; imageUrl: string } | null> {
  const db = createAdminClient();
  const { data: proof } = await db
    .from("delivery_proofs")
    .select("image_url")
    .eq("id", proofId)
    .single();
  if (!proof?.image_url) return null;

  const storagePath = proof.image_url.split("/delivery-proofs/")[1];
  if (!storagePath) return null;

  const { data: signedData } = await db.storage
    .from("delivery-proofs")
    .createSignedUrl(storagePath, 600); // 10 min — enough for WhatsApp to fetch
  if (!signedData?.signedUrl) return null;

  // Uploaded once and addressed as many times as there are recipients: a media
  // id is reusable within the WABA, and re-fetching the same jpeg per number
  // would put the buyer's photo and the recipient's minutes apart.
  return {
    mediaId: await fetchAndUploadImage(signedData.signedUrl),
    imageUrl: proof.image_url,
  };
}

/**
 * Sends one proof image to one number and writes it into that number's own
 * thread.
 *
 * `logToCustomerId` is null for a registered recipient who has never written to
 * us: there is no thread to write into. The send still happens — that is the
 * whole point of registering them — and `handleForwardedProof` records it in
 * `edit_log` instead.
 */
async function deliverProof(params: {
  mediaId: string;
  imageUrl: string;
  phone: string;
  logToCustomerId: string | null;
  open: boolean;
  sentBy?: string;
}): Promise<void> {
  // Inside the window the photo carries its own caption, as one message. It
  // used to go as a template with an image header and no body, followed by the
  // caption as a separate free-form text — so a customer received a bare photo
  // with no word about what it was, and the sentence explaining it either
  // arrived detached or, out of the window, not at all. The template is still
  // the only shape that can leave the window, so it stays for that case, and a
  // closed window is exactly where the follow-up text would be rejected anyway.
  const conversationId = params.logToCustomerId
    ? await saveMessage({
        customerId: params.logToCustomerId,
        role: "assistant",
        // Caption in `content`, file in `media_url` — the shape
        // `/api/inbox/manual-image` writes and `getInboxDocument` reads. The
        // URL used to sit in `content` with no caption anywhere, which is why
        // the inbox drew the photo and none of the words that went with it.
        content: params.open ? PROOF_CAPTION : "[Foto pengiriman]",
        mediaUrl: params.imageUrl,
        messageType: "image",
        modelUsed: "human",
        sentBy: params.sentBy ?? null,
      })
    : null;

  const messageId = params.open
    ? await sendImageMessageById(params.phone, params.mediaId, PROOF_CAPTION)
    : await sendImageTemplate(params.phone, "delivery_proof", params.mediaId, []);

  if (conversationId)
    await updateMessageReceipt({
      conversationId,
      whatsappMessageId: messageId,
      status: "sent",
    });
}

/**
 * Pushes a delivery photo to the buyer **and to every recipient they have
 * registered** in `customer_contacts`.
 *
 * Returns one row per number it was handed to, so the caller can tell the
 * forwarder who received it and whose window was shut. Handed to, never
 * arrived: a template send returns 200 `accepted` whatever the window says,
 * and its refusal turns up later in the status webhook.
 *
 * A recipient's send is wrapped on its own. The buyer's photo must not be lost
 * because a number an admin typed in last week has since been blocked.
 */
export async function sendDeliveryPhotoToCustomer(
  proofId: string,
  customerId: string,
  deliveries?: DeliveryRow[],
  // Set when an admin pressed Send on the Proofs screen. Left undefined by the
  // automatic matcher, which is the bot acting on its own.
  sentBy?: string,
): Promise<ProofSend[]> {
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
  let name = delivery?.customers?.name ?? null;
  if (!phone) {
    const { data: customer } = await db
      .from("customers")
      .select("phone_number, name")
      .eq("id", customerId)
      .single();
    phone = customer?.phone_number ?? undefined;
    name = customer?.name ?? null;
  }

  if (!phone) {
    console.error(
      `[sendDeliveryPhotoToCustomer] no phone for customer ${customerId}`,
    );
    return [];
  }

  const media = await proofMedia(proofId);
  if (!media) return [];

  const sends: ProofSend[] = [];

  const ownerHours = await hoursSinceInbound(customerId);
  await deliverProof({
    ...media,
    phone,
    logToCustomerId: customerId,
    open: ownerHours < WINDOW_HOURS,
    sentBy,
  });
  sends.push({ owner: true, name, phone, hours: ownerHours });

  for (const recipient of await proofRecipientsFor(db, customerId)) {
    // The recipient's own window, not the buyer's. They are different numbers
    // and the one that keeps answering is usually the recipient — which is the
    // reason this fan-out exists.
    const hours = recipient.customerId
      ? await hoursSinceInbound(recipient.customerId)
      : Number.POSITIVE_INFINITY;
    try {
      await deliverProof({
        ...media,
        phone: recipient.phone,
        logToCustomerId: recipient.customerId,
        open: hours < WINDOW_HOURS,
        sentBy,
      });
      await logEdit({
        db,
        actor: systemActor("delivery-proof-recipient"),
        entityType: "customer_contacts",
        entityId: recipient.id,
        action: "send",
        changes: {
          proof_id: proofId,
          owner_customer_id: customerId,
          phone: recipient.phone,
          window_open: hours < WINDOW_HOURS,
        },
      });
      sends.push({
        owner: false,
        name: recipient.name,
        phone: recipient.phone,
        hours,
      });
    } catch (err) {
      console.error(
        `[sendDeliveryPhotoToCustomer] recipient ${recipient.phone} failed:`,
        (err as Error).message,
      );
    }
  }

  return sends;
}
