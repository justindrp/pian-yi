import type Anthropic from "@anthropic-ai/sdk";
import type { NextRequest } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import {
  getNeighborhoods,
  getSetting,
  getTemplate,
} from "@/lib/cache/settings";
import { analyzeCustomerMessage } from "@/lib/claude/analyze-customer-message";
import {
  extractText,
  getAnthropicClient,
  HAIKU_MODEL,
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
  applyLatestCustomerSize,
  contractPrice,
  createOrderFromExtraction,
  type ExtractedOrderInput,
  extractOrderFromConversation,
  extractOrderProperties,
  resizePendingOrderFromMessage,
  shouldRecordName,
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
import {
  IMAGE_STAGE_DIRECTION,
  sanitizeReply,
} from "@/lib/claude/sanitize-reply";
import { validateReply } from "@/lib/claude/validate-reply";
import {
  hasCurrentOrder,
  normalizeCustomerState,
  shouldHandlePaymentProof,
} from "@/lib/customers/lifecycle";
import { shouldAutoResume } from "@/lib/customers/takeover";
import { holidayOn, isClosedHoliday } from "@/lib/holidays/id";
import { describeMenuWeeks } from "@/lib/menu/week";
import {
  loadCustomerSchedule,
  unbookedByOrder,
} from "@/lib/orders/customer-schedule";
import { pickDrawOrder } from "@/lib/orders/pick-draw-order";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { unionAreas } from "@/lib/subcontractors/areas";
import { createAdminClient } from "@/lib/supabase/admin";
import { jakartaTimeString } from "@/lib/time/jakarta";
import { calcTypingDelay, sleep } from "@/lib/utils/delay";
import {
  downloadMedia,
  sendImageByUrl,
  sendTextMessage,
  sendTypingIndicator,
} from "@/lib/whatsapp/client";
import { isDemoPhone } from "@/lib/whatsapp/demo";
import { storeInboundMedia } from "@/lib/whatsapp/media-store";
import {
  parseMessage,
  parseStatusUpdates,
  type WhatsAppWebhookPayload,
} from "@/lib/whatsapp/types";
import { verifySignature } from "@/lib/whatsapp/webhook";
import { WINDOW_NOTICE_WELCOME } from "@/lib/whatsapp/window-notice";
import type { Json } from "@/types/database";

// Phrases the model uses to say it is creating the order right now. Matched only
// to catch a turn where it said this and called no tool.
const ORDER_PROMISE =
  /\b(saya|aku|kami)\s+(catat|proses|buatkan|siapkan|input)\b|\b(catat|proses|buatkan|siapkan)\s+(pesanan|ordernya|order)\b|sudah\s+((saya|aku|kami)\s+)?(catat|tercatat|dibuat|diproses)|pesanan(nya)?\s+(saya|aku|kami)\s+(catat|proses|buat)/i;

// The model saying it sent the menu. It does this instead of calling the tool:
// Nicholas Satria was told "menu minggu ini sudah saya kirim gambarnya ya" with
// no image anywhere in the thread and answered "blmm ada kak", and Sherine
// Fayola was told to check one above that had never been sent.
//
// Widened on 2026-08-26. The original required "sudah/udah/telah" between the
// noun and the verb, which is only the *past* tense of the lie. ****7277 was
// told "Berikut menu gambar untuk minggu ini ... saya kirimkan ya" and then
// "Saya kirimkan lagi menu minggu ini ... sekarang ya" — a present-tense claim
// and an explicit re-send promise, no tool call behind either, and neither
// matched. A promise to send in this same message is a claim: the customer goes
// looking for the image either way. A genuinely future "nanti saya kirim" is
// excluded below, because that one is still true when nothing goes out now.
const MENU_SENT_CLAIM = new RegExp(
  [
    // "menu ... sudah saya kirim", the original past-tense shape
    /(menu|gambar|foto)[\s\S]{0,80}?(sudah|udah|telah)\s+((saya|aku|kami)\s+)?(kirim|kirimkan|share|lampirkan)/
      .source,
    // "saya kirimkan menunya ya" / "menunya saya kirimkan sekarang"
    /(saya|aku|kami)\s+(kirim|kirimkan|share|lampirkan)(kan)?\s+(lagi\s+)?(gambar\s+)?(menu|foto|price\s*list|daftar harga)/
      .source,
    // "menunya saya kirimkan", and with the week wedged in between:
    // "Menu minggu ini saya kirimkan ya kak". Bounded to one sentence so it
    // cannot reach across a full stop into an unrelated clause.
    /(menu|gambar|foto)\w*[^.!?\n]{0,40}?\s(saya|aku|kami)\s+(kirim|kirimkan|share|lampirkan)\w*/
      .source,
    // "berikut menu ..." / "ini dia menunya" — presenting something not attached.
    // `\w*` on the noun because Indonesian suffixes it: "menunya", "gambarnya".
    /(berikut|ini dia|terlampir|silakan (dilihat|dicek))[\s\S]{0,40}?\b(menu|gambar|foto)\w*/
      .source,
    // The stage direction itself.
    IMAGE_STAGE_DIRECTION.source,
  ].join("|"),
  "i",
);

// "nanti saya kirim menunya" is a promise about a later turn, not a claim that
// an image is attached to this one. Firing the menu at a customer who was just
// told to expect it later contradicts the reply they are reading, so these
// spans are cut before the claim is matched — cut, not used to veto the whole
// reply, because one message can do both: promise next week's menu later and
// claim this week's now. Only what is left counts as a claim.
const MENU_SEND_DEFERRED =
  /\b(nanti|besok|setelah|kalau sudah|begitu|menyusul)\b[^.!?\n]{0,60}?\b(kirim|kirimkan)\w*|\b(kirim|kirimkan)\w*[^.!?\n]{0,30}?\b(menyusul|nanti|besok)\b/gi;

/** Whether the reply tells the customer an image is on its way right now. */
export function claimsMenuSent(replyText: string): boolean {
  return MENU_SENT_CLAIM.test(replyText.replace(MENU_SEND_DEFERRED, " "));
}

// The model saying it will check with the team. It writes this instead of
// calling ask_admin_for_help, so nothing is flagged, no admin is pushed, and
// the customer waits for an answer nobody was ever asked for. On 2026-08-20 an
// ad lead asked what a no-rice portion contains and what it costs, was told
// "perlu saya cek dulu ke tim" twice, and wrote "Batal..ribet" nine minutes
// after his first message. An addressee is required — "perlu saya cek dulu
// sesuai total porsi" is the model stalling on its own arithmetic, not a claim
// that a human is involved.
const ESCALATION_CLAIM =
  /(cek|konfirmasi|tanya|tanyakan|koordinasi|pastikan)[\s\S]{0,40}?\b(ke|sama|dengan|dgn)\s+(tim|admin|dapur|partner|atasan|kantor|rekan)/i;

// The model confirms delivery dates to a customer who already has a package and
// calls no tool, so nothing reaches the sheet and no kitchen is told. Fahmi
// paused on 11 Agustus, asked on 22 Agustus to resume, and was answered "saya
// jadwalkan pengiriman mulai Senin 24 Agustus ya" — no record_daily_order, no
// row, and nothing else would have caught it, because the nightly generator
// only ever books tomorrow for orders it can see. On the 24th he wrote "Dah
// nyampe blom kak" about food nobody had cooked. Matched only to decide whether
// a turn is worth re-reading; the dates themselves come from the model below.
const SCHEDULE_PROMISE =
  /\b(jadwalkan|dijadwalkan|jadwalnya|kirim|kirimkan|antar|antarkan|diantar|mulai)\b[\s\S]{0,60}?(\b(senin|selasa|rabu|kamis|jumat|jum'at|sabtu|besok|lusa)\b|\b\d{1,2}\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\b|\b\d{4}-\d{2}-\d{2}\b)/i;

/**
 * Read the dates out of a reply that promised a schedule and called no tool.
 *
 * A second model call rather than a regex, because "mulai Senin 24 Agustus",
 * "besok dan lusa" and "Senin sampai Jumat depan" all have to resolve to ISO
 * dates against the WIB clock. It only has to produce the argument list: the
 * record_daily_order handler is where every safety check already lives (an
 * active order, pickDrawOrder, the customer-wide quota gate, libur nasional,
 * and the double-booking skip), so a wrong guess is dropped there rather than
 * written. Returns null on anything it is not sure about.
 */
async function extractPromisedSchedule(params: {
  customerMessage: string;
  reply: string;
  defaultPortions: number;
}): Promise<{
  delivery_dates: string[];
  meal_type: "lunch" | "dinner" | "both";
  portions: number;
} | null> {
  const today = jakartaTimeString().slice(0, 10);
  try {
    const client = getAnthropicClient();
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      ...NO_THINKING,
      max_tokens: 300,
      system: `Hari ini ${today} (WIB). Baca balasan admin di bawah dan tentukan tanggal pengiriman yang SUDAH dijanjikan ke customer.

Jawab HANYA JSON, tanpa penjelasan:
{"delivery_dates":["YYYY-MM-DD"],"meal_type":"lunch"|"dinner"|"both","portions":<angka per tanggal>}

Aturan:
- Kembalikan {"delivery_dates":[]} kalau balasan itu hanya menawarkan, bertanya, atau belum memastikan tanggal.
- "mulai <tanggal>" tanpa tanggal akhir berarti SATU tanggal saja: tanggal itu.
- Jangan pernah menebak tanggal yang tidak disebut. Jangan masukkan tanggal sebelum ${today}.
- Minggu tidak pernah menjadi tanggal pengiriman.`,
      messages: [
        {
          role: "user",
          content: `Pesan customer:\n${params.customerMessage}\n\nBalasan admin:\n${params.reply}`,
        },
      ],
    });
    const raw = extractText(res);
    const match = raw?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as {
      delivery_dates?: unknown;
      meal_type?: unknown;
      portions?: unknown;
    };
    const dates = Array.isArray(parsed.delivery_dates)
      ? parsed.delivery_dates.filter(
          (d): d is string =>
            typeof d === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(d) &&
            d >= today,
        )
      : [];
    if (dates.length === 0) return null;
    const meal =
      parsed.meal_type === "lunch" ||
      parsed.meal_type === "dinner" ||
      parsed.meal_type === "both"
        ? parsed.meal_type
        : null;
    if (!meal) return null;
    const portions =
      typeof parsed.portions === "number" && parsed.portions > 0
        ? Math.floor(parsed.portions)
        : params.defaultPortions;
    return { delivery_dates: dates, meal_type: meal, portions };
  } catch (err) {
    console.error(
      "[webhook] schedule recovery extraction failed:",
      (err as Error).message,
    );
    return null;
  }
}

/** Whether a question is already sitting with an admin for this customer. */
async function hasPendingAdminQuestion(customerId: string): Promise<boolean> {
  const db = createAdminClient();
  const { data } = await db
    .from("customer_flags")
    .select("pending_bot_response")
    .eq("customer_id", customerId)
    .maybeSingle();
  return data?.pending_bot_response === true;
}

/**
 * Park the question the model claimed to be escalating.
 *
 * Deliberately does not call handleToolUse: that path also sends the customer
 * "Mohon tunggu sebentar kak, kami sedang cek dulu ya", and the reply we are
 * about to send already says exactly that. The customer would get it twice.
 */
async function recordClaimedEscalation(
  customerId: string,
  phone: string,
  customerName: string | null,
  question: string,
): Promise<void> {
  const db = createAdminClient();
  await db
    .from("customer_flags")
    .update({
      pending_bot_response: true,
      pending_bot_question: question,
    })
    .eq("customer_id", customerId);

  await sendPushToAllAdmins(
    `Butuh jawaban — ${customerName ?? phone}`,
    question.slice(0, 120),
    "/inbox",
    "high",
  );
}

/**
 * Whether we have sent this customer an image since they last spoke.
 *
 * This used to be a flat 15-minute window, and the window was the bug. The
 * welcome sequence fires a price list and a menu on first contact, so for the
 * next quarter of an hour every menu claim the model made read as true and the
 * resend was skipped. ****7277 got the welcome images at 10:20:11, asked to see
 * the menu variants at 10:26:15, and was told twice that the menu was on its
 * way — 10:26:46 and 10:30:10, both inside the window, both suppressed, neither
 * image sent. They replied "belum ada fotonya kak maaf".
 *
 * The customer's own last message is the right boundary. An image sent after it
 * is one they have not looked for yet, so the claim is true; anything older is
 * a different question, already answered, and asking again earns a resend. It
 * also keeps the welcome sequence from double-sending: those images land after
 * the first inbound, so a claim in the same turn is correctly left alone.
 */
async function sentImageSinceLastInbound(customerId: string): Promise<boolean> {
  const db = createAdminClient();
  const { data: lastInbound } = await db
    .from("conversations")
    .select("created_at")
    .eq("customer_id", customerId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // No inbound message at all: nothing to measure against, and nothing this
  // customer is waiting on. Treat as sent so we do not fire a menu unprompted.
  if (!lastInbound?.created_at) return true;

  const { data } = await db
    .from("conversations")
    .select("id")
    .eq("customer_id", customerId)
    .eq("role", "assistant")
    .eq("message_type", "image")
    .gte("created_at", lastInbound.created_at)
    .limit(1);
  return (data ?? []).length > 0;
}

// Every number the customer typed, and the package sizes each one could mean.
// A count of days is a count of portions when there is one meal a day and twice
// that with two ("20 hari" → 20 or 40); a duration in weeks is five or six days
// each. Bare numbers count too — "mau ambil yg 5 ka" is a renewal.
const TYPED_NUMBER = /(?<![\d.,])(\d{1,3})(?![\d.,])/g;
const TYPED_WEEKS = /(?<![\d.,])(\d{1,2})\s*minggu\b/gi;

/** How far back a purchase can have been stated and still be this conversation. */
const BUY_EVIDENCE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Whether the customer themselves typed a number that could be this package
 * size. Recovery hands a whole conversation to a model that will return an
 * order shape for a chat containing none, so the extraction is not evidence of
 * a purchase — a size the customer actually said is.
 *
 * On 2026-08-19 five phantom orders reached four real customers in three hours:
 * Nicholas Satria asked "menu minggu ini apa yaa" and was billed Rp 280.000
 * twenty-seven seconds later, rebuilt out of his July renewal chat; Julian S
 * asked to skip two deliveries and got Rp 145.000; galvent asked whether the
 * portions came with fruit; Sherine Fayola asked whether she could swap days.
 * None of them had named a package.
 *
 * Two bounds on the window, both load-bearing: newer than their newest order,
 * because the messages that produced that order are exactly what recovery would
 * rebuild, and inside the last 48 hours, because a month-old thread is not this
 * turn.
 */
async function customerStatedSize(
  customerId: string,
  sinceIso: string | undefined,
  size: number,
): Promise<boolean> {
  const db = createAdminClient();
  const cutoff = new Date(Date.now() - BUY_EVIDENCE_WINDOW_MS).toISOString();
  const since = sinceIso && sinceIso > cutoff ? sinceIso : cutoff;
  const { data } = await db
    .from("conversations")
    .select("content")
    .eq("customer_id", customerId)
    .eq("role", "user")
    .gt("created_at", since)
    .order("created_at", { ascending: false })
    .limit(40);
  for (const row of data ?? []) {
    const text = String(row.content ?? "");
    for (const m of text.matchAll(TYPED_WEEKS)) {
      const weeks = Number(m[1]);
      for (const days of [5, 6]) {
        if (size === weeks * days || size === weeks * days * 2) return true;
      }
    }
    for (const m of text.matchAll(TYPED_NUMBER)) {
      const n = Number(m[1]);
      if (n > 0 && (size === n || size === n * 2)) return true;
    }
  }
  return false;
}

/**
 * Flags a conversation that looks like it contains an order the bot never
 * booked, and tells an admin. It does not create anything.
 *
 * It used to. `recoverOrderFromConversation` built the order itself and let
 * `createOrderFromExtraction` send the bank details, which is how a guess
 * turned into a bill: Nicholas Satria asked what the week's menu was and was
 * charged Rp 280.000 twenty-seven seconds later; Julian S asked to skip two
 * deliveries and got Rp 145.000; Nadya asked to move one delivery to lunch and
 * her finished package came back as Rp 540.000; Fahmi asked where his dinner
 * was and was billed Rp 448.000 for the sixteen portions he had already paid
 * for, on an order whose past `start_date` also forged a `delivered` row for a
 * meal nobody cooked.
 *
 * Eight guards were added over those six incidents and the seventh still got
 * through, because the thing being guarded is unguardable: "16 porsi" in a chat
 * is genuinely ambiguous between buying sixteen and scheduling sixteen already
 * owned. No text rule separates them. What was fixable was the consequence —
 * an inference no longer holds write authority, so a wrong one costs a
 * notification instead of a customer.
 *
 * Three filters survive, and only to keep the push rare: the extraction found
 * an order, the customer typed the size themselves, and it is not one already
 * on file. The rest went with the write.
 */
async function flagOrderAtRisk(
  customerId: string,
  phone: string,
  customerName: string | null,
  reason: string,
): Promise<boolean> {
  const db = createAdminClient();
  const { data: orders } = await db
    .from("orders")
    .select("id, status, package_size, start_date, created_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });

  // Recovery re-reads the chat, so for a customer who has ordered before, the
  // window must start after their newest order — otherwise the messages that
  // produced that order are still in view and get read as a second one.
  const newestOrder = (orders ?? [])[0];

  try {
    const raw = await extractOrderFromConversation(customerId, {
      since: newestOrder?.created_at ?? undefined,
    });
    if (!raw || raw.package_size <= 0) return false;

    // The customer has to have named this package. The trigger fires on every
    // reply that called no tool, and without this it flagged every browser.
    if (
      !(await customerStatedSize(
        customerId,
        newestOrder?.created_at ?? undefined,
        raw.package_size,
      ))
    ) {
      return false;
    }

    // An extraction that reproduces an order already on file is the old
    // conversation echoing, never a new purchase. Same size and same start, or
    // the same size on anything bought in this same window — Nicholas's phantom
    // matched his active package on size and differed only on a start date the
    // extraction had invented.
    const echoesExistingOrder = (orders ?? []).some(
      (o) =>
        o.package_size === raw.package_size &&
        (o.start_date === raw.start_date ||
          (o.created_at ?? "") >
            new Date(Date.now() - BUY_EVIDENCE_WINDOW_MS).toISOString()),
    );
    if (echoesExistingOrder) return false;

    // One push per unresolved flag. The trigger fires on every turn, and an
    // admin who has already been told does not need telling again each time the
    // customer writes.
    const { data: flags } = await db
      .from("customer_flags")
      .select("needs_human_review")
      .eq("customer_id", customerId)
      .maybeSingle();
    if (flags?.needs_human_review === true) return false;

    const note = `${raw.package_size} porsi${raw.start_date ? `, mulai ${raw.start_date}` : ""} — ${reason}`;
    await db
      .from("customer_flags")
      .update({
        needs_human_review: true,
        escalation_reason: `Kemungkinan order belum tercatat: ${note}`,
      })
      .eq("customer_id", customerId);

    await sendPushToAllAdmins(
      `Order mungkin belum tercatat — ${customerName ?? phone}`,
      note,
      "/inbox",
      "high",
    );
    console.log(
      `[webhook] order at risk flagged (${reason}) for ${customerId}: ${note}`,
    );
    return true;
  } catch (err) {
    console.error(
      `[webhook] order-at-risk flag (${reason}) failed:`,
      (err as Error).message,
    );
    return false;
  }
}

/** How many of the most recent assistant replies in a row ended up asking something. */
async function consecutiveUnansweredQuestions(
  customerId: string,
): Promise<number> {
  const db = createAdminClient();
  const { data } = await db
    .from("conversations")
    .select("role, content")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(12);
  let streak = 0;
  for (const row of data ?? []) {
    if (row.role !== "assistant") continue;
    if (!row.content?.includes("?")) break;
    streak += 1;
  }
  return streak;
}

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
      markWebhookEvent(
        eventId,
        err instanceof Error ? err.message : String(err),
      );
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
        errors: statusUpdate.errors,
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
  let latestOrderStatus = latestOrder?.status ?? null;

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
    if (
      message.type === "image" &&
      message.imageId &&
      shouldHandlePaymentProof(latestOrderStatus)
    ) {
      await handlePaymentProofImage(
        message,
        customerId,
        customer.name,
        message.from,
        { sendConfirmation: false },
      );
      await db
        .from("processed_messages")
        .update({ processed_at: new Date().toISOString() })
        .eq("message_id", message.messageId);
      return;
    }
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

  // A pending admin question no longer silences the bot. This branch used to
  // save the message, push, and return — so one escalated side question ("bisa
  // sampai sebelum 10.30?", "ada potongan PPh?") stopped the bot answering
  // anything, for the rest of the thread, until a human cleared the flag. Both
  // Tiwi and PT Bintang Lautan lost their whole order that way in replay: every
  // customer turn after the escalation went unanswered, including the address,
  // the portion count and "mohon kabari nomor rekening". The question still
  // reaches an admin (the push below and `pending_bot_question`), and the model
  // is told in the prompt not to answer it itself — but the ordering
  // conversation keeps running, because nothing in creating an order needs a
  // human.
  const pendingAdminQuestion = flags?.pending_bot_response
    ? (flags.pending_bot_question ?? "")
    : null;
  if (pendingAdminQuestion !== null) {
    await sendPushToAllAdmins(
      "New message — question still unanswered",
      `${customer.name ?? message.from}: ${pendingAdminQuestion.slice(0, 80)}`,
      "/inbox",
      "high",
    );
  }

  // Payment proof: capture image when the latest order is still pending payment
  if (message.type === "image" && message.imageId) {
    // A customer who transfers before the bot ever called extract_order has no
    // order for the proof to attach to, and the image is then just another
    // photo in the inbox: Theresia agreed to 5 porsi on 2026-08-03, sent the
    // transfer slip, and was asked to confirm the summary again. Money had
    // arrived and nothing recorded a purchase. Build the order from the
    // conversation with the same forced-tool extraction the admin inbox uses —
    // it returns null when the chat genuinely never contained an order, so a
    // random photo from a browsing customer creates nothing.
    if (latestOrderStatus === null) {
      try {
        const extracted = await extractOrderFromConversation(customerId);
        if (extracted && extracted.package_size > 0 && extracted.address) {
          await createOrderFromExtraction(
            customerId,
            message.from,
            await applyLatestCustomerSize(customerId, extracted),
            { sendPaymentInfo: false },
          );
          latestOrderStatus = "pending_payment";
          await sendPushToAllAdmins(
            `Order dibuat dari bukti bayar — ${customer.name ?? message.from}`,
            `${extracted.package_size} porsi. Belum ada order saat bukti masuk — cek halaman Payments`,
            "/payments",
            "high",
          );
        }
      } catch (err) {
        console.error(
          "[webhook] payment-proof order recovery failed:",
          (err as Error).message,
        );
      }
    }

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

      const uniqueAreas = unionAreas(activeDapurs);
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

      // The incoming message is already saved above, before any branch runs, so
      // it sorts ahead of the welcome replies without a second write. This used
      // to save it again here and the insert failed on `message_id`'s unique
      // constraint for every new customer's first message — harmless, but it put
      // a "saveMessage failed" line in the log on the happiest path there is,
      // which is how a real dropped write goes unnoticed.
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
  // Demo (replay) customers skip the wait: their bursts are pre-merged by the
  // replay harness, so the 15s would only multiply a 20-conversation run by an
  // hour without changing what the model sees.
  if (coalesceBurst && messageId && !isDemoPhone(phone)) {
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

  // A size the customer changes before paying amends the order they already
  // have — it is not a second order and not a question. Tiwi asked for "Total 8
  // porsi", got the transfer details, then wrote "Boleh 6 porsi dulu kak"; the
  // order stayed at 8 and she was left holding a bill for a package she had
  // just reduced. Run it before the model call so the reply is generated
  // against the amended order. Draft mode changes nothing on the customer's
  // side, so it is skipped there.
  if (!draft) {
    await resizePendingOrderFromMessage(customerId, phone, text).catch(
      console.error,
    );
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
      .select("id, package_size, portions_per_delivery")
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
  const servedAreas = unionAreas(rawSubs);
  const neighborhoods = await getNeighborhoods();
  const activeOrder = activeOrderRow
    ? {
        id: activeOrderRow.id,
        packageSize: activeOrderRow.package_size,
        portionsPerDelivery: activeOrderRow.portions_per_delivery,
      }
    : null;

  // A question that is already with an admin and still unanswered. It no longer
  // silences the bot — it only tells the model which one thing to leave alone.
  const { data: pendingFlags } = await db
    .from("customer_flags")
    .select("pending_bot_response, pending_bot_question")
    .eq("customer_id", customerId)
    .single();
  const pendingAdminQuestion = pendingFlags?.pending_bot_response
    ? (pendingFlags.pending_bot_question ?? "")
    : null;

  // What is actually booked, so the model stops reconstructing the schedule
  // from the chat scrollback and quoting the wrong "sisa kuota". Both numbers
  // on it are counted from the delivery rows — the only place either has ever
  // been.
  const schedule = await loadCustomerSchedule(db, customerId);

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
    schedule,
    pendingAdminQuestion,
    // A corporate customer's negotiated rate replaces the whole price list.
    contractPricePerPortion: await contractPrice(customerId),
  });

  // Tool definitions
  const tools: Anthropic.Messages.Tool[] = [
    {
      name: "extract_order",
      description:
        'Creates the customer\'s order. Call this as soon as the customer has agreed to a package — any affirmative counts ("ya", "iya", "oke", "sip", "boleh", "saya join", a thumbs-up), not only the literal word "YA" — and you have their name, address and total portions. Call it also when a customer sends a payment proof and no order exists yet. Never ask for confirmation a second time instead of calling this.',
      input_schema: {
        type: "object",
        properties: extractOrderProperties(servedAreas),
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
        "Called when a customer with an active quota-based order requests one or more deliveries. Inserts a daily delivery row per date and decrements their quota. Pass EVERY date the customer agreed to in one call — a Senin–Jumat run is one call with five dates, never five calls. Only call this for customers who already have an active order with quota left.",
      input_schema: {
        type: "object",
        properties: {
          delivery_dates: {
            type: "array",
            items: { type: "string" },
            description:
              "Every requested delivery date as ISO YYYY-MM-DD. One entry for a single day; all of them for a multi-day schedule.",
          },
          meal_type: {
            type: "string",
            enum: ["lunch", "dinner", "both"],
          },
          portions: {
            type: "number",
            description:
              "Portions per delivery date, not the total (e.g. 2 for a 1-portion keduanya order — 1 lunch + 1 dinner on that date). Total deducted is this number times the number of dates.",
          },
          notes: { type: "string" },
        },
        required: ["delivery_dates", "meal_type", "portions"],
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
      name: "record_customer_name",
      description:
        'Saves the customer\'s name to their record. Call this the moment they tell you their name — answering "boleh tahu nama kakak?", or signing off with it — and never claim you have noted a name without calling this in the same message. Only fills a name that is missing; it never renames anyone. The name is what an admin sees in the inbox and what the courier reads off the delivery label.',
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'The name the customer gave, exactly as they wrote it. Never an honorific ("kak", "kakak") or a stand-in ("unknown", "customer") — if they have not given a name, do not call this tool.',
          },
        },
        required: ["name"],
      },
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
  // Every tool_use block, not just the last one: this used to keep only the
  // final block, so a reply that called two tools silently ran one of them.
  const toolUses: Anthropic.Messages.ToolUseBlock[] = [];

  for (const block of claudeResponse.content) {
    if (block.type === "text") replyText = block.text;
    if (block.type === "tool_use") toolUses.push(block);
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

  if (!replyText && toolUses.length === 0) {
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
  for (const toolUse of toolUses) {
    await handleToolUse(toolUse, customerId, phone, customerName);
  }

  // An order the conversation already contains must never die in a turn that
  // did not create it. Two named shapes used to trigger this — a promise the
  // model never kept ("saya catat pesanannya sekarang"), and a clarification
  // loop where it asks one more question every turn — and both kept missing new
  // ones: Fahmi agreed to 20 porsi dinner, sent his address as a photo, and was
  // asked for his name; Febby asked to add 30 porsi and was told the admin was
  // being consulted. Neither reply promised anything and neither ended in a
  // loop, and both orders were lost. So the trigger is simply: the model
  // replied and did not call extract_order. The two shapes survive only as the
  // reason we hand the admin.
  //
  // What this does with the answer changed on 2026-08-25: it flags and pushes,
  // it does not build. See flagOrderAtRisk.
  if (replyText && !toolUses.some((t) => t.name === "extract_order")) {
    const promised = ORDER_PROMISE.test(replyText);
    const looping =
      replyText.includes("?") &&
      (await consecutiveUnansweredQuestions(customerId)) >= 2;
    await flagOrderAtRisk(
      customerId,
      phone,
      customerName,
      promised
        ? "an unkept promise"
        : looping
          ? "a clarification loop"
          : "a turn that created no order",
    );
  }

  // The model claims to have sent the menu instead of calling the tool, and the
  // customer is left looking for an image that does not exist. Sending it twice
  // costs nothing; telling someone to check an image we never sent does.
  if (
    replyText &&
    !toolUses.some((t) => t.name === "send_menu_image") &&
    claimsMenuSent(replyText) &&
    !(await sentImageSinceLastInbound(customerId))
  ) {
    console.log(
      `[webhook] menu claimed but never sent — sending it for ${customerId}`,
    );
    await handleToolUse(
      {
        type: "tool_use",
        id: "menu-claim",
        name: "send_menu_image",
        input: {},
        caller: null,
      } as unknown as Anthropic.Messages.ToolUseBlock,
      customerId,
      phone,
      customerName,
    );
  }

  // The model promises a delivery date to a customer who already has quota and
  // calls no tool. Nothing is booked, the kitchen is never told, and the
  // customer waits for food that was never cooked (see SCHEDULE_PROMISE). Book
  // it through the same handler the tool call would have gone through, so every
  // guard in it still applies; if the dates cannot be recovered, push instead,
  // because the customer has already been told they are set.
  if (
    replyText &&
    activeOrder &&
    (schedule?.unbooked ?? 0) > 0 &&
    !toolUses.some((t) => t.name === "record_daily_order") &&
    SCHEDULE_PROMISE.test(replyText)
  ) {
    const promisedSchedule = await extractPromisedSchedule({
      customerMessage: text,
      reply: replyText,
      defaultPortions: activeOrder.portionsPerDelivery ?? 1,
    });
    if (promisedSchedule) {
      console.log(
        `[webhook] schedule promised but never booked — recording ${promisedSchedule.delivery_dates.join(", ")} for ${customerId}`,
      );
      await handleToolUse(
        {
          type: "tool_use",
          id: "schedule-promise",
          name: "record_daily_order",
          input: promisedSchedule,
          caller: null,
        } as unknown as Anthropic.Messages.ToolUseBlock,
        customerId,
        phone,
        customerName,
      );
    } else {
      console.warn(
        `[webhook] schedule promised but no dates could be recovered for ${customerId}`,
      );
      await sendPushToAllAdmins(
        `Jadwal dijanjikan tapi tidak tercatat — ${customerName ?? phone}`,
        "Bot menyanggupi tanggal pengiriman tanpa memanggil tool, dan tanggalnya tidak bisa dibaca ulang",
        "/inbox",
        "high",
      );
    }
  }

  // The model says it is checking with the team and calls no tool. Nothing is
  // flagged and no admin is pushed, so the customer is waiting on a question
  // that was never asked. Park it ourselves and push, using the customer's own
  // message as the question — it is what an admin has to answer anyway.
  if (
    replyText &&
    !toolUses.some(
      (t) => t.name === "ask_admin_for_help" || t.name === "escalate_to_human",
    ) &&
    ESCALATION_CLAIM.test(replyText) &&
    !(await hasPendingAdminQuestion(customerId))
  ) {
    console.log(
      `[webhook] escalation claimed but never made — parking it for ${customerId}`,
    );
    await recordClaimedEscalation(customerId, phone, customerName, text);
  }

  // A tool call with no text alongside it. Anthropic models answer and call a
  // tool in the same response, so one round trip was enough; a reasoning model
  // spends the turn on `thinking` + `tool_use` and emits no text, which left the
  // customer with total silence whenever the tool was a no-op (Julie W got
  // send_menu_image on an already-sent menu). Feed the tool result back and ask
  // for the reply that should have come with it.
  if (toolUses.length > 0 && !replyText) {
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
            content: toolUses.map((t) => ({
              type: "tool_result" as const,
              tool_use_id: t.id,
              content: "done",
            })),
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
      transcript: [
        ...history.slice(-10).map((m) => ({
          role: m.role as string,
          content:
            typeof m.content === "string"
              ? m.content
              : m.content
                  .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
                  .join(" "),
        })),
        { role: "user", content: text },
      ],
      customerState: stateRow?.state ?? "new",
      activeOrder: activeOrder
        ? {
            unbooked: schedule?.unbooked ?? 0,
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
              // This instruction used to say "hanya gunakan fakta dari Current
              // context di system prompt. Jika data tidak tersedia, katakan
              // akan dicek dulu." Both halves were wrong and cost real orders.
              //
              // "Only Current context" is narrower than the validator's own
              // rule, which explicitly does NOT flag business info. Current
              // context holds this customer's row, not the pricing ladder or
              // the custom-request exceptions — so on retry the model lost
              // access to facts it legitimately had and reversed correct
              // answers. On 2026-08-26 +6287895957020 was told tanpa nasi is
              // free (right), then after a retry that it needed to "cek dulu
              // ke tim" about the price (wrong, and there is no such rate to
              // check). The customer deferred and the thread stalled.
              //
              // "Katakan akan dicek dulu" is worse: nothing schedules that
              // follow-up, so it is a promise the business cannot keep. It is
              // the exact shape /api/cron/stalled-leads now has to detect
              // after the fact. Ask the customer instead — they are right
              // there, and they are the only source for their own data.
              content: `Balasan sebelumnya berisi klaim tentang data pelanggan ini yang tidak didukung: ${validation.unsupportedClaims.join(", ")}.

Tulis ulang balasan itu dengan HANYA memperbaiki klaim tersebut — bagian lain yang sudah benar biarkan apa adanya.

Aturan bisnis di system prompt (harga, menu, area, hari pengiriman, ketentuan permintaan khusus) tetap boleh dipakai sepenuhnya. Yang tidak boleh ditebak hanya data pribadi pelanggan ini: nama, sisa kuota, ukuran paket, status order, status pembayaran.

Kalau data pelanggan itu memang belum diketahui, tanyakan langsung ke pelanggannya. Jangan pernah menjanjikan akan mengecek dulu ke tim atau ke admin — tidak ada yang menjadwalkan follow-up itu, jadi janji seperti itu tidak akan pernah ditepati.`,
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
  // A parked or taken-over thread still has to bank the proof and advance the
  // order — that is bookkeeping, not the bot talking — but the customer must
  // not get an automated reply on a thread a human is holding.
  options?: { sendConfirmation?: boolean },
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

  if (options?.sendConfirmation === false) {
    await sendPushToAllAdmins(
      `Bukti bayar diterima — ${customerName ?? phone}`,
      "Thread sedang dipegang admin. Cek halaman Payments",
      "/payments",
      "high",
    );
    return;
  }

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
      await applyLatestCustomerSize(
        customerId,
        tool.input as ExtractedOrderInput,
      ),
    );
  } else if (tool.name === "record_daily_order") {
    const input = tool.input as {
      delivery_dates?: string[];
      delivery_date?: string;
      meal_type: "lunch" | "dinner" | "both";
      portions: number;
      notes?: string;
    };

    // One call books the whole run. delivery_date is still read because older
    // conversation histories carry it, and the model copies what it sees.
    const dates = Array.from(
      new Set(
        (
          input.delivery_dates ??
          (input.delivery_date ? [input.delivery_date] : [])
        ).filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)),
      ),
    ).sort();

    if (dates.length === 0) {
      console.error(
        "[webhook] record_daily_order: no valid delivery date",
        JSON.stringify(tool.input),
      );
      return;
    }

    // Every active order, with its undated portions counted from the delivery
    // rows. This used to read the stored `orders.portions_remaining`, a counter
    // nothing kept honest — the daily sheet's delete button removed a row and
    // left it where it was — and on 2026-08-24 it disagreed with the rows for
    // 63 of the 195 customers holding an active order. Vania's read 0 with ten
    // portions genuinely left, so this bailed and three dinners the bot had
    // already confirmed to her were never written. The column is gone now.
    const { data: activeOrders } = await db
      .from("orders")
      .select("id, package_size, start_date, created_at, subcontractor_id")
      .eq("customer_id", customerId)
      .eq("status", "active");

    const candidates = activeOrders ?? [];
    if (candidates.length === 0) {
      console.error(
        "[webhook] record_daily_order: no active order for customer",
        customerId,
      );
      return;
    }

    const unbookedPerOrder = await unbookedByOrder(
      db,
      candidates.map((o) => ({ id: o.id, package_size: o.package_size })),
    );

    // Which package the rows bill to: the oldest one that still has undated
    // portions, per pickDrawOrder. Nothing else narrows the field. Quota
    // belongs to the customer, not to one package — an order records that they
    // topped up their balance, and two orders held by the same customer are the
    // same money.
    //
    // A meal filter used to run first, preferring orders whose
    // meal_time_preference covered the requested meal. Measured against
    // production on 2026-08-28 it changed the outcome for 3 of the 89 customers
    // holding two or more active orders, and all 3 were wrong: it skipped the
    // older package and charged the newer one, which is the exact
    // misattribution pickDrawOrder was written to stop.
    const order = pickDrawOrder(
      candidates.map((o) => ({
        ...o,
        unbooked: unbookedPerOrder.get(o.id) ?? 0,
      })),
    );

    if (!order) {
      console.error(
        "[webhook] record_daily_order: no draw order for customer",
        customerId,
      );
      return;
    }

    // The gate is customer-wide: a customer with two packages can draw across
    // both, and pickDrawOrder above decides which one the row is charged to.
    const custUnbooked =
      (await loadCustomerSchedule(db, customerId))?.unbooked ?? 0;

    if (custUnbooked <= 0) {
      console.warn(
        "[webhook] record_daily_order: every portion this customer bought already has a date",
        customerId,
      );
      // Never a silent drop: the bot has already told the customer the dates
      // are booked by the time this runs, so somebody has to know it did not
      // happen.
      await sendPushToAllAdmins(
        `Order harian tidak tercatat — ${customerName ?? phone}`,
        `Bot menyanggupi ${dates.length} tanggal, tapi semua porsi customer sudah punya tanggal`,
        "/deliveries",
        "high",
      );
      return;
    }

    // A libur nasional is a day we are definitely shut, and the model schedules
    // straight through one — it put 25 Agustus (Maulid Nabi) in an eight-day run
    // in the simulator even with the holiday list in its prompt. Dropping the
    // date here is the guarantee; the prompt rule is the first layer.
    const closedDates = dates.filter((d) => isClosedHoliday(d));
    const openDates = dates.filter((d) => !isClosedHoliday(d));

    if (openDates.length === 0) {
      console.warn(
        "[webhook] record_daily_order: every requested date is a holiday",
        JSON.stringify(closedDates),
      );
      await sendPushToAllAdmins(
        `Order harian jatuh di tanggal merah — ${customerName ?? phone}`,
        `${closedDates.map((d) => holidayOn(d)?.name ?? d).join(", ")} — tidak ada yang tercatat`,
        "/deliveries",
        "high",
      );
      return;
    }

    // The model re-states a schedule while confirming it, so the same dates can
    // arrive twice. Skip whatever is already on the sheet rather than double-book.
    const { data: existingRows } = await db
      .from("daily_deliveries")
      .select("delivery_date")
      .eq("customer_id", customerId)
      .in("delivery_date", openDates);
    const alreadyBooked = new Set(
      (existingRows ?? []).map((r) => r.delivery_date),
    );
    const fresh = openDates.filter((d) => !alreadyBooked.has(d));

    // portions is per date. Book only as many dates as the quota covers — a
    // multi-day request must not be the thing that pushes an order negative.
    const perDate = Math.max(1, input.portions);
    const affordable = Math.floor(custUnbooked / perDate);
    const booking = fresh.slice(0, affordable);

    if (booking.length === 0) {
      console.warn(
        "[webhook] record_daily_order: nothing to book",
        JSON.stringify({
          dates,
          alreadyBooked: [...alreadyBooked],
          affordable,
        }),
      );
      return;
    }

    const { error: insertError } = await db.from("daily_deliveries").insert(
      booking.map((delivery_date) => ({
        order_id: order.id,
        customer_id: customerId,
        delivery_date,
        meal_type: input.meal_type,
        portions: perDate,
        subcontractor_id: order.subcontractor_id,
        notes: input.notes ?? null,
      })),
    );
    if (insertError) {
      console.error(
        "[webhook] record_daily_order: insert failed:",
        insertError.message,
      );
      await sendPushToAllAdmins(
        `Order harian GAGAL — ${customerName ?? phone}`,
        `${booking.length} hari tidak tersimpan: ${insertError.message}`,
        "/deliveries",
        "high",
      );
      return;
    }

    const deducted = booking.length * perDate;

    // Nothing to deduct on the order: the rows just inserted are the deduction.
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
            custQuota.portions_remaining - deducted,
          ),
        })
        .eq("id", customerId);
    }

    const span =
      booking.length === 1
        ? booking[0]
        : `${booking[0]} – ${booking[booking.length - 1]} (${booking.length} hari)`;
    await sendPushToAllAdmins(
      `Order harian — ${customerName ?? phone}`,
      `${span} ${input.meal_type} × ${perDate} porsi/hari`,
      "/deliveries",
      "low",
    );

    // The customer was told a schedule that runs through a day we are shut. The
    // bot may or may not have said so, so a human has to check.
    if (closedDates.length > 0) {
      await sendPushToAllAdmins(
        `Tanggal merah dilewati — ${customerName ?? phone}`,
        closedDates
          .map((d) => `${d} ${holidayOn(d)?.name ?? "libur"}`)
          .join(", "),
        "/deliveries",
        "high",
      );
    }

    // The customer was told a schedule the quota could not cover. A human has to
    // tell them, so this is not a low-priority note.
    if (booking.length < fresh.length) {
      await sendPushToAllAdmins(
        `Kuota kurang — ${customerName ?? phone}`,
        `Diminta ${fresh.length} hari, hanya ${booking.length} tercatat (${custUnbooked} porsi belum punya tanggal)`,
        "/deliveries",
        "high",
      );
    }
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
  } else if (tool.name === "record_customer_name") {
    // Before this tool existed the bot had no way to write a name outside of
    // extract_order, so when +6285692715738 answered "keira" on 2026-08-26 it
    // replied "nama kakak sudah saya catat sebagai Keira" and wrote nothing —
    // the same empty claim BOT_RULES.md forbids for orders.
    const input = tool.input as { name?: string };
    const given = (input.name ?? "").trim();
    const { data: current } = await db
      .from("customers")
      .select("name")
      .eq("id", customerId)
      .single();
    if (shouldRecordName(given, current?.name)) {
      await db.from("customers").update({ name: given }).eq("id", customerId);
      await logEdit({
        db,
        actor: "system:webhook:record_customer_name",
        entityType: "customers",
        entityId: customerId,
        action: "update",
        changes: { name: { from: current?.name ?? null, to: given } },
      });
    }
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
