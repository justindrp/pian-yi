import { compressUploadedImage } from "@/lib/images/compress";
import {
  extractText,
  getAnthropicClient,
  HAIKU_MODEL,
  NO_THINKING,
} from "./client";

// DeepSeek caps an image at 1024 tokens however large it arrives, so shrinking
// past its own ~1300px resize buys no tokens — this budget is about upload
// bytes and latency on the customer reply path, nothing else.
const VISION_MAX_BYTES = 1_500_000;

// Ceiling for a figure read off a slip. See the note where it is applied.
const MAX_PLAUSIBLE_IDR = 100_000_000;

/**
 * Asks the model about an image. Returns null on any failure.
 *
 * Never throws: every caller has a working no-vision path that predates this
 * file, and a model outage must fall back to it rather than cost the customer
 * their reply.
 *
 * `NO_THINKING` for the same reason as everywhere else, and measured here
 * specifically: across 36 real payment slips, thinking mode agreed with the
 * plain read on 33, matched the order total no more often (27/36 either way),
 * took 2x the median latency, spent 8.6x the output tokens, and on one slip
 * returned `stop_reason: "max_tokens"` with a thinking block and no text at
 * all — the silent-reply failure, at 1500 max_tokens on an ordinary image.
 */
export async function askVision(params: {
  image: Buffer;
  prompt: string;
  maxTokens?: number;
}): Promise<string | null> {
  let jpeg: Buffer;
  try {
    jpeg = (await compressUploadedImage(params.image, VISION_MAX_BYTES)).buffer;
  } catch (err) {
    console.error(
      "[vision] compress failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  try {
    const client = getAnthropicClient();
    // Images are rejected in system and assistant messages (400), so the image
    // rides the user turn. That also keeps the cached system prefix intact.
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      ...NO_THINKING,
      max_tokens: params.maxTokens ?? 500,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: jpeg.toString("base64"),
              },
            },
            { type: "text", text: params.prompt },
          ],
        },
      ],
    });
    return extractText(res) || null;
  } catch (err) {
    console.error(
      "[vision] request failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export interface PaymentSlipRead {
  isTransferReceipt: boolean;
  amountIdr: number | null;
  recipientName: string | null;
  bank: string | null;
  datetime: string | null;
}

const SLIP_PROMPT = `Ini screenshot bukti transfer bank dari pelanggan catering.
Baca gambar dan kembalikan JSON saja, tanpa penjelasan:
{"is_transfer_receipt": true/false, "amount_idr": <angka bulat tanpa titik atau koma, null kalau tidak terbaca>, "recipient_name": "<nama penerima persis seperti tertulis, null kalau tidak ada>", "bank": "<nama bank, null kalau tidak ada>", "datetime": "<tanggal dan jam persis seperti tertulis, null kalau tidak ada>"}`;

/**
 * Reads a transfer slip. Returns null when the model is unavailable or its
 * answer will not parse — the proof is still banked either way, so a null here
 * only means the admin gets no pre-read.
 */
export async function readPaymentSlip(
  image: Buffer,
): Promise<PaymentSlipRead | null> {
  const text = await askVision({ image, prompt: SLIP_PROMPT, maxTokens: 400 });
  if (!text) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(
      text
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "")
        .trim(),
    );
  } catch {
    console.error("[vision] slip JSON did not parse:", text.slice(0, 200));
    return null;
  }

  const amount =
    typeof raw.amount_idr === "number" && Number.isFinite(raw.amount_idr)
      ? Math.round(raw.amount_idr)
      : null;

  return {
    isTransferReceipt: raw.is_transfer_receipt === true,
    // A thousand-separator misread put one slip in 36 at 145.000.000 for a
    // 145.000 transfer, so a figure outside what this business can plausibly
    // bill is dropped rather than shown to an admin as if it had been read.
    // The largest real order to date is 1,91 juta and the ladder tops out near
    // 4 juta, so 100 juta sits far above any true total and well under the
    // 1000x slip. Nothing downstream pays on this number either way.
    amountIdr:
      amount !== null && amount > 0 && amount <= MAX_PLAUSIBLE_IDR
        ? amount
        : null,
    recipientName:
      typeof raw.recipient_name === "string" ? raw.recipient_name : null,
    bank: typeof raw.bank === "string" ? raw.bank : null,
    datetime: typeof raw.datetime === "string" ? raw.datetime : null,
  };
}

/**
 * Whether a slip figure agrees with the orders the proof was applied to.
 *
 * The sum counts, not only a single total: one transfer routinely covers more
 * than one order, and a proof read as 685.000 against orders of 540.000 and
 * 145.000 is a correct read, not a mismatch. Null amount means no verdict —
 * never `false`, which would read as a contradiction the model never made.
 */
export function slipMatchesTotals(
  amountIdr: number | null,
  totals: number[],
): boolean | null {
  if (amountIdr === null || totals.length === 0) return null;
  const sum = totals.reduce((a, b) => a + b, 0);
  return totals.includes(amountIdr) || amountIdr === sum;
}

const DESCRIBE_PROMPT = `Kamu asisten WhatsApp katering harian. Pelanggan mengirim gambar ini tanpa teks apa pun.
Jelaskan isinya dalam satu kalimat bahasa Indonesia yang padat, supaya rekanmu tahu apa yang dikirim tanpa melihat gambarnya.
Sebutkan tulisan penting yang terbaca. Jangan menyapa, jangan menebak maksud pelanggan, jangan menambah basa-basi.`;

/**
 * One-line description of an image a customer sent with no caption, written to
 * stand in for the caption the turn never got. Returns null when unavailable,
 * which puts the caller back on the "please send text" reply it used before.
 */
export async function describeCustomerImage(
  image: Buffer,
): Promise<string | null> {
  const text = await askVision({
    image,
    prompt: DESCRIBE_PROMPT,
    maxTokens: 300,
  });
  return text?.trim() || null;
}
