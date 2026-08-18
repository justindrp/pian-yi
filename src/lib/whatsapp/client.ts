import axios from "axios";
import FormData from "form-data";
import sharp from "sharp";
import { demoMessageId, isDemoPhone } from "@/lib/whatsapp/demo";

const BASE_URL = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}`;
type MetaSendResponse = {
  messages?: Array<{
    id?: string;
  }>;
};

const headers = () => ({
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  "Content-Type": "application/json",
});

// axios has no default timeout, so a Meta socket that goes quiet blocks whatever
// is awaiting it for as long as the process lives. Two replay turns on 2026-08-19
// wedged for over five minutes on inbound media, and the same call sits in the
// webhook's path — an unbounded wait there is a customer message that never gets
// a reply. Media downloads get longer than sends because they carry bytes.
const SEND_TIMEOUT_MS = 20_000;
const MEDIA_TIMEOUT_MS = 60_000;

function getSentMessageId(data: MetaSendResponse): string {
  const messageId = data.messages?.[0]?.id;
  if (!messageId) {
    throw new Error("WhatsApp send response missing message id");
  }
  return messageId;
}

// Meta's error for "the customer's 24-hour service window has closed". Nothing
// we send can reopen it — only an inbound message from the customer does — so
// callers need to tell this apart from a transient API failure and say so,
// rather than retrying or showing a raw Meta dump. 470 is the legacy code for
// the same condition, still returned by older API versions.
const WINDOW_CLOSED_CODES = new Set([131047, 470]);

// Carries Meta's numeric error code alongside the message. The code lives in
// the response body, so without this every caller would have to regex the
// stringified payload back out of the message.
export class WhatsAppApiError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.name = "WhatsAppApiError";
    this.code = code;
  }
}

export function isOutsideWindowError(err: unknown): boolean {
  return err instanceof WhatsAppApiError && err.code !== null && WINDOW_CLOSED_CODES.has(err.code);
}

// Strips the axios config (which contains the Authorization header) before
// re-throwing, so Next.js error logging can't leak the token.
function sanitizeAxiosError(err: unknown): never {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: { code?: number } } | undefined;
    console.error("[whatsapp/client] Meta API error:", JSON.stringify(data));
    throw new WhatsAppApiError(
      `WhatsApp API error ${err.response?.status}: ${JSON.stringify(data)}`,
      data?.error?.code ?? null,
    );
  }
  throw err;
}

export async function sendTextMessage(
  to: string,
  text: string,
): Promise<string> {
  if (isDemoPhone(to)) return demoMessageId();

  const res = await axios.post<MetaSendResponse>(
    `${BASE_URL}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text },
    },
    { headers: headers(), timeout: SEND_TIMEOUT_MS },
  ).catch(sanitizeAxiosError);
  return getSentMessageId(res.data);
}

export async function sendImageMessage(
  to: string,
  imageUrl: string,
  caption: string,
): Promise<string> {
  if (isDemoPhone(to)) return demoMessageId();

  const res = await axios.post<MetaSendResponse>(
    `${BASE_URL}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "image",
      image: { link: imageUrl, caption },
    },
    { headers: headers(), timeout: SEND_TIMEOUT_MS },
  ).catch(sanitizeAxiosError);
  return getSentMessageId(res.data);
}

export async function uploadMediaToMeta(
  buffer: Buffer,
  mimeType: string,
  filename?: string,
): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
  form.append("file", buffer, {
    contentType: mimeType,
    filename: filename ?? `image.${ext}`,
  });
  const res = await axios.post<{ id: string }>(`${BASE_URL}/media`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    },
  }).catch(sanitizeAxiosError);
  return res.data.id;
}

export async function sendImageMessageById(
  to: string,
  mediaId: string,
  caption: string,
): Promise<string> {
  if (isDemoPhone(to)) return demoMessageId();

  const res = await axios.post<MetaSendResponse>(
    `${BASE_URL}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "image",
      image: { id: mediaId, caption },
    },
    { headers: headers(), timeout: SEND_TIMEOUT_MS },
  ).catch(sanitizeAxiosError);
  return getSentMessageId(res.data);
}

export async function sendDocumentMessageById(
  to: string,
  mediaId: string,
  filename: string,
  caption: string,
): Promise<string> {
  if (isDemoPhone(to)) return demoMessageId();

  const res = await axios.post<MetaSendResponse>(
    `${BASE_URL}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "document",
      document: { id: mediaId, filename, caption },
    },
    { headers: headers(), timeout: SEND_TIMEOUT_MS },
  ).catch(sanitizeAxiosError);
  return getSentMessageId(res.data);
}

export async function downloadMedia(mediaId: string): Promise<Buffer> {
  const token = process.env.WHATSAPP_TOKEN;
  const version = process.env.WHATSAPP_API_VERSION;
  const metaRes = await axios.get(
    `https://graph.facebook.com/${version}/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: SEND_TIMEOUT_MS },
  ).catch(sanitizeAxiosError);
  const mediaUrl = (metaRes.data as { url: string }).url;
  const dlRes = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: "arraybuffer",
    timeout: MEDIA_TIMEOUT_MS,
  }).catch(sanitizeAxiosError);
  return Buffer.from(dlRes.data as ArrayBuffer);
}

export async function sendTypingIndicator(
  _to: string,
  messageId: string,
): Promise<void> {
  if (isDemoPhone(_to)) return;

  // Mark as read and show typing indicator in one request (per Meta API docs)
  await axios
    .post(
      `${BASE_URL}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      },
      { headers: headers(), timeout: SEND_TIMEOUT_MS },
    )
    .catch(() => {});
}

export async function sendImageByUrl(
  to: string,
  imageUrl: string,
  caption: string,
): Promise<string> {
  if (isDemoPhone(to)) return demoMessageId();

  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  // Compress to JPEG ≤4MB so Meta's 5MB upload limit is never hit
  const compressed = await sharp(raw)
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  const mediaId = await uploadMediaToMeta(compressed, "image/jpeg");
  return sendImageMessageById(to, mediaId, caption);
}

export async function fetchAndUploadImage(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const compressed = await sharp(raw)
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  return uploadMediaToMeta(compressed, "image/jpeg");
}

/**
 * Sends a plain-text (no header media) approved template. Templates are the only
 * way to reach a customer whose 24h service window has closed.
 */
export async function sendTextTemplate(
  to: string,
  templateName: string,
  bodyParams: string[],
  languageCode = "id",
): Promise<string> {
  if (isDemoPhone(to)) return demoMessageId();

  const res = await axios.post<MetaSendResponse>(
    `${BASE_URL}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components:
          bodyParams.length > 0
            ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }]
            : [],
      },
    },
    { headers: headers(), timeout: SEND_TIMEOUT_MS },
  ).catch(sanitizeAxiosError);
  return getSentMessageId(res.data);
}

export async function sendImageTemplate(
  to: string,
  templateName: string,
  mediaId: string,
  bodyParams: string[],
  languageCode = "id",
): Promise<string> {
  if (isDemoPhone(to)) return demoMessageId();

  const res = await axios.post<MetaSendResponse>(
    `${BASE_URL}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [
          {
            type: "header",
            parameters: [{ type: "image", image: { id: mediaId } }],
          },
          ...(bodyParams.length > 0
            ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }]
            : []),
        ],
      },
    },
    { headers: headers(), timeout: SEND_TIMEOUT_MS },
  ).catch(sanitizeAxiosError);
  return getSentMessageId(res.data);
}
