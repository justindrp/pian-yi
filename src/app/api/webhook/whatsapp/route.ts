import type Anthropic from "@anthropic-ai/sdk";
import type { NextRequest } from "next/server";
import { logEdit, systemActor } from "@/lib/audit/log-edit";
import {
  getExcludedNeighborhoods,
  getNeighborhoods,
  getSetting,
  getTemplate,
} from "@/lib/cache/settings";
import { analyzeCustomerMessage } from "@/lib/claude/analyze-customer-message";
import {
  extractText,
  getAnthropicClient,
  HAIKU_MODEL,
  modelTag,
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
  minPackageSize,
  resizePendingOrderFromMessage,
  shouldRecordName,
} from "@/lib/claude/extract-order";
import { fixWeekdayNames } from "@/lib/claude/fix-dates";
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
import { RESUMED_FLAGS, shouldAutoResume } from "@/lib/customers/takeover";
import {
  handleForwardedProof,
  isProofForwarder,
} from "@/lib/deliveries/forwarded-proof";
import { resendFailedProofs } from "@/lib/deliveries/resend-failed-proof";
import { deliveryWindow, loadKitchenWindows } from "@/lib/deliveries/windows";
import { formatHolidayDate } from "@/lib/holidays/id";
import { sendInvoice } from "@/lib/invoices/send";
import { findMapsLink, isSharedPinLink } from "@/lib/maps/link";
import {
  describeMenuWeeks,
  formatMenuWeekRange,
  jakartaDateString,
  menuSentToolMessage,
} from "@/lib/menu/week";
import { loadCustomerSchedule } from "@/lib/orders/customer-schedule";
import {
  type DeleteDeliveriesInput,
  deleteDeliveries,
} from "@/lib/orders/delete-deliveries";
import {
  type RecordDailyOrderInput,
  recordDailyOrder,
} from "@/lib/orders/record-daily-order";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { activeDeliveryAreas, unionAreas } from "@/lib/subcontractors/areas";
import { coverageNotes } from "@/lib/subcontractors/coverage";
import { daysLabel } from "@/lib/subcontractors/days";
import { kitchensForCustomer } from "@/lib/subcontractors/for-customer";
import { createAdminClient } from "@/lib/supabase/admin";
import { jakartaMinuteOfDay, jakartaTimeString } from "@/lib/time/jakarta";
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
  type WhatsAppMessage,
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
// claim this week's now. Only what is left counts as a claim. Shared with the
// delivery-proof claim below, which defers the same way.
const SEND_DEFERRED =
  /\b(nanti|besok|setelah|kalau sudah|begitu|menyusul)\b[^.!?\n]{0,60}?\b(kirim|kirimkan)\w*|\b(kirim|kirimkan)\w*[^.!?\n]{0,30}?\b(menyusul|nanti|besok)\b/gi;

/** Whether the reply tells the customer an image is on its way right now. */
export function claimsMenuSent(replyText: string): boolean {
  return MENU_SENT_CLAIM.test(replyText.replace(SEND_DEFERRED, " "));
}

// The model saying it sent the delivery photo. Same failure as the menu claim,
// with the proof instead of the menu: Clairine Aurelia wrote "Uda diantar ya"
// on 2026-08-31 and was answered "pesananmu sudah diantar hari ini, dan kami
// sudah kirimkan foto buktinya ya kak" with no send_delivery_proof call behind
// it. She had messaged in specifically to open the window for that photo, and
// the reply told her it had already been sent.
//
// The noun has to be the proof, not any image: "bukti", or "foto" bound to
// pengiriman/pengantaran. A bare "fotonya" is left to the menu claim, which is
// the more common sense of it and already recovers.
const PROOF_NOUN =
  /(bukti\w*(\s+(pengiriman|pengantaran|antar)\w*)?|foto\s+(bukti|pengiriman|pengantaran)\w*)/
    .source;
const PROOF_SENT_CLAIM = new RegExp(
  [
    // "foto buktinya sudah kami kirim"
    `${PROOF_NOUN}[^.!?\\n]{0,60}?\\b(kirim|kirimkan|dikirim|terkirim|share|lampirkan)\\w*`,
    // "kami sudah kirimkan foto buktinya"
    `\\b(kirim|kirimkan|dikirim|terkirim|share|lampirkan)\\w*[^.!?\\n]{0,40}?${PROOF_NOUN}`,
    // presenting something not attached
    `\\b(berikut|ini dia|terlampir|silakan (dilihat|dicek))\\b[^.!?\\n]{0,40}?${PROOF_NOUN}`,
  ].join("|"),
  "i",
);

/** Whether the reply tells the customer the delivery photo went out this turn. */
export function claimsProofSent(replyText: string): boolean {
  return PROOF_SENT_CLAIM.test(replyText.replace(SEND_DEFERRED, " "));
}

// Only what the reply asserts. A question ("apakah makanannya sudah sampai
// kak?") and a condition ("kalau sudah sampai, kabari ya") are built out of the
// same words as the claim and assert nothing.
function assertedSentences(replyText: string): string {
  return replyText
    .split(/(?<=[.!?\n])/)
    .filter(
      (s) => !s.includes("?") && !/\b(kalau|kalo|jika|apabila|bila)\b/i.test(s),
    )
    .join(" ");
}

// The model announcing that it will go and look for the delivery photo — "saya
// cek foto pengirimannya dulu ya" — and calling no tool. claimsProofSent leaves
// it alone because nothing was said to have been sent, and ESCALATION_CLAIM
// leaves it alone because no addressee is named, so nothing recovers it and
// nothing schedules the second turn the promise implies. The check it announces
// is one query: there is nothing to go away and do, so a reply that says it is
// checking is always a stall.
//
// Naya asked at 11:09 on 2026-09-02 whether her food had arrived and was told
// five times across 46 minutes that the photo was being looked for — once with
// "anterannya udah sampai kak" invented on top of it — before a person took the
// thread over. The food had not been delivered.
const PROOF_CHECK_CLAIM = new RegExp(
  [
    `\\b(cek|ngecek|dicek|cekin|cari|nyari|dicari|cariin|carikan|lihat|liat|dilihat|periksa|pastikan)\\w*\\b[^.!?\\n]{0,40}?${PROOF_NOUN}`,
    `${PROOF_NOUN}[^.!?\\n]{0,40}?\\b(cek|dicek|cari|dicari|lihat|liat|dilihat|periksa|diperiksa)\\w*`,
  ].join("|"),
  "i",
);

// The model telling the customer their food arrived. The photo is the only
// thing that says a delivery happened, so an arrival asserted without one is
// the model answering with what the customer wants to hear.
const ARRIVED_CLAIM =
  /\b(pesanan|pesenan|makanan|makanannya|anteran|antaran|kiriman|catering|paket|order)\w*\b[^.!?\n]{0,30}?\b(sudah|udah|udh|telah)\s+(sampai|sampe|nyampe|tiba|diantar|dianter|dikirim|terkirim)/i;

// An arrival is only worth contradicting when the customer is the one asking.
// Someone who has just written "udah sampai kak, makasih" must never be
// answered "makanannya belum sampai" off a photo the kitchen simply never
// uploaded — the photo is our record of the delivery, not the customer's.
const ARRIVAL_WORD =
  /\b(sampai|sampe|nyampe|nyampai|dianter|diantar|dianterin|dikirim|anterannya|kurir|driver|lobby|telat|lama)\b/i;
// "udah" is not one of these. "kak cateringnya udh dianter?" is a question and
// "udah sampai kak makasih" is the opposite of one, and the only thing that
// separates them is the question mark and the complaint words around it.
const ASKING =
  /\?|\b(blm|belum|kok|masa|kenapa|napa|mana|gimana|gmn|kapan|telat|lama)\b/i;

/**
 * Whether the reply stalls on the delivery photo, or asserts a delivery it
 * never checked. Either way the answer was one query away and the turn ended
 * without it, so the guard runs the query the reply promised.
 */
export function claimsProofPending(
  replyText: string,
  inbound: string,
): boolean {
  const asserted = assertedSentences(replyText);
  if (PROOF_CHECK_CLAIM.test(asserted)) return true;
  return (
    ARRIVED_CLAIM.test(asserted) &&
    ARRIVAL_WORD.test(inbound) &&
    ASKING.test(inbound)
  );
}

// The model saying an invoice is on its way. Same failure as the menu claim,
// with a document instead of an image: Carolin was told twice on 2026-08-30
// that her invoice was being prepared, by a bot that had no way to make one,
// and both invoices she eventually got were rendered by hand.
const INVOICE_CLAIM =
  /\b(invoice|faktur|kwitansi|nota)\w*\b[^.!?\n]{0,60}?\b(kirim|dikirim|terkirim|saya kirim|attach|lampir)\w*|\b(kirim|dikirim|terkirim|lampir)\w*[^.!?\n]{0,40}?\b(invoice|faktur|kwitansi|nota)\w*/i;

// "invoice-nya menyusul ya kak" promises a later turn. Cut before matching, for
// the same reason the menu claim cuts its deferrals.
const INVOICE_DEFERRED =
  /\b(nanti|besok|setelah|kalau sudah|begitu|menyusul)\b[^.!?\n]{0,60}?\b(invoice|faktur|kirim)\w*|\b(invoice|faktur)\w*[^.!?\n]{0,30}?\b(menyusul|nanti|besok)\b/gi;

/** Whether the reply tells the customer an invoice is attached to this turn. */
export function claimsInvoiceSent(replyText: string): boolean {
  return INVOICE_CLAIM.test(replyText.replace(INVOICE_DEFERRED, " "));
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
const DATE_MENTION_SRC =
  /\b(senin|selasa|rabu|kamis|jumat|jum'at|sabtu|besok|lusa)\b|\b\d{1,2}\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\b|\b\d{4}-\d{2}-\d{2}\b/
    .source;
const DATE_MENTION = new RegExp(DATE_MENTION_SRC, "i");
const SCHEDULE_PROMISE = new RegExp(
  `\\b(jadwalkan|dijadwalkan|jadwalnya|kirim|kirimkan|antar|antarkan|diantar|mulai)\\b[\\s\\S]{0,60}?(${DATE_MENTION_SRC})`,
  "i",
);

// The model confirming a skip, a move or a cancellation of a scheduled day, in
// a turn that called no delete_deliveries. A skip is a DELETE and nothing else
// performs one, so a confirmation with no tool behind it changes nothing at all:
// the row stays on the kitchen sheet and the food is cooked. Febby asked on
// 2026-09-02 to skip Kamis and resume Jumat and was answered "Saya skip
// pengiriman Kamis besok dan lanjut lagi Jumat seperti biasa ya. Saya proses
// sekarang" — no tool call, and in her case no row on that Kamis either, so the
// reply was a confirmation of work that was neither done nor needed.
const SKIP_CLAIM = new RegExp(
  [
    // "saya skip pengiriman Kamis" / "aku hapus jadwal Jumat besok"
    /(saya|aku|kami)\s+(sudah\s+)?(skip|hapus|hapuskan|batalkan|pindahkan|geser)\w*/
      .source,
    // "Kamis di-skip ya kak" / "pengirimannya dibatalkan"
    /\b(di-?skip|dihapus|dibatalkan|dipindah\w*|digeser)\b/.source,
    // "skip Kamis, lanjut Jumat" — the customer's own words agreed to verbatim.
    /\bskip\w*\b[\s\S]{0,40}?\b(lanjut|dilanjut\w*)\b/.source,
  ].join("|"),
  "i",
);

// A refusal names the same verbs as a confirmation — "Kamis tidak bisa di-skip,
// pengirimannya sudah terkunci" is the correct answer past the cutoff, and it
// must not be read as a claim that something was deleted.
const SKIP_REFUSED =
  /\b(tidak|nggak|ga|gak|belum|tak)\s+(bisa|dapat|boleh|sempat)\b|terkunci|sudah\s+dikunci|sudah\s+(masuk|diproses)\s+dapur/i;

/** Whether the reply told a customer a scheduled day was skipped or moved. */
export function claimsSkipDone(replyText: string): boolean {
  return SKIP_CLAIM.test(replyText) && !SKIP_REFUSED.test(replyText);
}

/**
 * Whether the reply told a customer their dates are booked.
 *
 * Two shapes, because the promise and the dates are not always in the same
 * sentence. SCHEDULE_PROMISE is the delivery-verb shape ("saya jadwalkan mulai
 * Senin 24 Agustus"). The second is a booking promise anywhere in the reply
 * plus a date anywhere in it: on 2026-08-30 Vania sent "selasa 1 sep / rabu 2
 * sep / jumat 4 sep" and was answered with those three dates as a bulleted
 * confirmation, then "Saya catat pesanannya sekarang ya kak ✅ Sebentar ya,
 * saya proses dulu" — no delivery verb within 60 characters of any date, so
 * nothing matched, no recovery ran, and three dinners she had been told were
 * booked reached no kitchen sheet. She asked her remaining quota in the next
 * message and was told the arithmetic that assumed they existed.
 *
 * Widening the pre-filter is cheap: extractPromisedSchedule is the arbiter and
 * returns nothing for a reply that only offers or asks, and the caller has
 * already established that the customer holds unbooked quota and that no
 * record_daily_order ran this turn.
 */
export function promisesSchedule(replyText: string): boolean {
  return (
    SCHEDULE_PROMISE.test(replyText) ||
    (ORDER_PROMISE.test(replyText) && DATE_MENTION.test(replyText))
  );
}

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
 *
 * A third bound is the message type. An image row keeps its URL in `content`,
 * and a wamid is base64 — digits with letters either side, which is exactly
 * what TYPED_NUMBER matches. Julian S sent a payment proof and its URL offered
 * up a "3", so an extraction that had invented "6 porsi" read as a size he had
 * typed himself, and an admin got a push about an order he had already placed
 * and paid. Only text the customer actually wrote counts.
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
    .eq("message_type", "text")
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
    // conversation echoing, never a new purchase. Two shapes of echo:
    //
    // Same size, same start — Nicholas's phantom matched his active package on
    // size and differed only on a start date the extraction had invented.
    //
    // And any order bought inside the same 48-hour window, whatever its size:
    // the chat that produced it is the chat being re-extracted, so the
    // extraction is reading back the purchase that already happened. Julian S,
    // Carolin, Rachel and Veronica were all flagged for an order they had
    // placed and paid for a day earlier, only with a size the model had drifted
    // by one or two. A customer buying a genuinely second package inside two
    // days loses a push and nothing else — extract_order amends their open
    // order anyway.
    const boughtRecently = new Date(
      Date.now() - BUY_EVIDENCE_WINDOW_MS,
    ).toISOString();
    const echoesExistingOrder = (orders ?? []).some(
      (o) =>
        (o.created_at ?? "") > boughtRecently ||
        (o.package_size === raw.package_size &&
          o.start_date === raw.start_date),
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
// typing. See the burst-coalescing block in processWebhookAsync.
const BURST_WINDOW_MS = 15_000;

/**
 * Whether the customer has written again since the message this turn answers.
 *
 * Asked twice: once when the burst window closes, and again after the model
 * has spoken. The window closes before the Sonnet call, and that call plus the
 * validator plus the typing delay take another half-minute — so a customer
 * typing a message every twenty seconds has each one survive its own window
 * and land a turn on top of the last. Sharleen got five assistant messages in
 * thirty-four seconds on 2026-08-31, two of them contradicting each other
 * about whether she had ordered size S or M, and the bank transfer details
 * twice; the day before, a burst of three drew a reply that opened "Maaf kak,
 * saya balas ulang bagian sebelumnya nih".
 */
async function supersededByNewerMessage(
  db: ReturnType<typeof createAdminClient>,
  customerId: string,
  messageId: string,
): Promise<boolean> {
  const { data: newest } = await db
    .from("conversations")
    .select("message_id")
    .eq("customer_id", customerId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return Boolean(newest?.message_id && newest.message_id !== messageId);
}

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

/**
 * The inbound message rendered as inbox text. Images, documents and locations
 * carry no text of their own, so they get a placeholder; the media itself is
 * saved alongside via `mediaId` / `mediaUrl`.
 */
function inboundText(message: WhatsAppMessage): string {
  switch (message.type) {
    case "text":
      return message.text ?? "";
    case "image":
      return message.imageCaption ?? "[Image]";
    case "document":
      return formatDocumentMessage(message);
    case "location":
      return formatLocationMessage(message);
    default:
      return `[${message.type}]`;
  }
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
  if (insertError) {
    // 23505 is the unique violation, and the only failure that means someone
    // else already owns this message. Every other cause — a dropped
    // connection, a statement timeout, a permission error — means the claim
    // never landed, and returning here destroyed the message: POST marks the
    // `webhook_events` row processed as soon as this function resolves, Meta
    // already has its 200 and never retries, and nothing was written to
    // `conversations` for a human to find. Throwing routes it to
    // markWebhookEvent(eventId, err) instead, which is what leaves the stored
    // payload replayable.
    if (insertError.code === "23505") return;
    throw insertError;
  }

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

  // An admin forwarding a delivery photo from their own handset. Images only:
  // the same number may be an ordinary `customers` row (it is, for Justin's),
  // and swallowing its text as well would take that thread away from the bot
  // for good. A photo with a customer name in the caption is unambiguous; a
  // text message from the same number is not.
  if (message.type === "image" && (await isProofForwarder(message.from))) {
    await handleForwardedProof(message);
    await db
      .from("processed_messages")
      .update({ processed_at: new Date().toISOString() })
      .eq("message_id", message.messageId);
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

  // Kill switch. It sits below the customer upsert, and saves both halves of
  // the exchange on the way out, because "the AI must not answer" is not "stop
  // ingesting WhatsApp" — with the bot off, the human inbox is the only thing
  // left to answer with. It used to return above the upsert, which left no
  // customer row, nothing in `conversations`, and no record of the template we
  // sent back. `processed_messages` had already claimed the message by then,
  // so re-enabling the bot could never reprocess it and no admin could see it:
  // every message received while the bot was off was destroyed, not delayed.
  const chatbotEnabled = await getSetting("chatbot_enabled");
  if (chatbotEnabled !== "true") {
    const offText = inboundText(message);
    await saveMessage({
      customerId,
      role: "user",
      content: offText,
      messageId: message.messageId,
      intent: "other",
      messageType: mediaMessageType(message.type),
      mediaId: mediaIdOf(message),
      mediaUrl: await inboundMediaUrl(),
    });
    const tmpl = await getTemplate("chatbot_unavailable");
    const conversationId = await saveMessage({
      customerId,
      role: "assistant",
      content: tmpl,
      modelUsed: "system",
    });
    const whatsappMessageId = await sendTextMessage(message.from, tmpl);
    await updateMessageReceipt({
      conversationId,
      whatsappMessageId,
      status: "sent",
    });
    // The same push the normal path sends for every inbound message. Without
    // it the message lands in an inbox nobody has been told to look at, which
    // is the state the kill switch is supposed to make safe.
    await sendPushToAllAdmins(
      "New message — bot is off",
      `${customer.name ?? message.from}: ${offText.slice(0, 80)}`,
      "/inbox",
      "high",
    );
    await db
      .from("processed_messages")
      .update({ processed_at: new Date().toISOString() })
      .eq("message_id", message.messageId);
    return;
  }

  const { data: stateRow } = await db
    .from("customer_state")
    .select("state, menu_shown")
    .eq("customer_id", customerId)
    .single();

  // Check flags
  const { data: flags } = await db
    .from("customer_flags")
    .select(
      "escalated_to_human, is_blacklisted, pending_bot_response, pending_bot_question, last_human_activity_at, hold_until",
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
    flags?.escalated_to_human === true && shouldAutoResume(flags);
  if (autoResumed) {
    await tryLearnCustomerContext(customerId, db);
    await db
      .from("customer_flags")
      .update(RESUMED_FLAGS)
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
    // Keep the snapshot honest. stateRow was read near the top of this
    // function and is handed to processSavedCustomerMessage below, which feeds
    // it straight to buildSystemPrompt — so without this the model is told
    // customerState "new" on the very turn the customer started ordering.
    if (stateRow) stateRow.state = "ordering";
  }

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
  // which reads as human on WhatsApp.
  //
  // The wait sits here, directly after the inbound row is saved, rather than
  // inside processSavedCustomerMessage where it used to. Down there it only
  // coalesced the reply itself: a burst still paid for one learn-context call,
  // one message analysis, one admin push and one welcome-sequence check per
  // message, several of which are model calls. Everything above this point is
  // either free or has to happen per message — classifyIntent fills the row we
  // just wrote, and the payment-proof, escalation and media branches all
  // returned long before here. Everything below happens once per burst.
  //
  // Demo (replay) customers skip the wait: their bursts are pre-merged by the
  // replay harness, so the 15s would only multiply a 20-conversation run by an
  // hour without changing what the model sees.
  if (!isDemoPhone(message.from)) {
    await sleep(BURST_WINDOW_MS);
    if (await supersededByNewerMessage(db, customerId, message.messageId)) {
      console.log(
        `[webhook] ${message.messageId} superseded before the model call, no reply`,
      );
      // Still stamp it. The message was handled — the decision was to let the
      // next one answer for it — and an unstamped row is what webhook-recovery
      // reads as work that died mid-flight.
      await db
        .from("processed_messages")
        .update({ processed_at: new Date().toISOString() })
        .eq("message_id", message.messageId);
      return;
    }
  }

  // A proof whose push failed while the window was shut. The customer writing
  // in is what reopens it, so this is the one moment the retry can work. Never
  // fatal: the reply matters more than the photo.
  await resendFailedProofs(customerId).catch((err) =>
    console.error("[webhook] proof resend failed:", (err as Error).message),
  );

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

  // Send welcome sequence on first contact — atomic claim prevents duplicate sends
  // when two messages arrive before the first one sets menu_shown = true.
  // Skip entirely if the customer already has an order (e.g. legacy-imported
  // customers whose customer_state row never got menu_shown set) — they go
  // straight to Claude, which treats them as a returning customer.
  // The model gets a turn after this block whether or not the welcome fired,
  // and on the turn that follows it there is nothing left for the model to say
  // — the greeting, price list, menu and T&C have just gone out, and the rules
  // forbid repeating any of them. Tell the prompt so it can hand that turn a
  // job instead. See `justWelcomed` in `buildSystemPrompt`.
  let justWelcomed = false;
  if (!stateRow?.menu_shown && !latestOrderStatus) {
    const { data: claimed } = await db
      .from("customer_state")
      .update({ menu_shown: true })
      .eq("customer_id", customerId)
      .or("menu_shown.is.null,menu_shown.eq.false")
      .select("customer_id");
    // True either way now — this request claimed it, or a concurrent one did.
    // The stale snapshot told the model menuShown:false immediately after the
    // welcome sequence had sent the menu, price list and T&C.
    if (stateRow) stateRow.menu_shown = true;

    if (claimed && claimed.length > 0) {
      justWelcomed = true;
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
          .select(
            "id, customer_nickname, menu_image_url, price_list_image_url, delivery_areas, delivery_days, lunch_window_start_min, lunch_window_end_min, dinner_window_start_min, dinner_window_end_min",
          )
          .eq("is_active", true)
          .not("menu_image_url", "is", null),
        db
          .from("pricing_tiers")
          .select("subcontractor_id, price_per_portion")
          .eq("portions", 20),
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

      // "mulai dari" is the cheapest kitchen's 20-portion rate, not the house
      // ladder's. Since migration 098 the house ladder is only what a kitchen
      // with no rows of its own is sold at, so quoting it flat is quoting a
      // price no kitchen near the customer may charge.
      const houseTier20 =
        (tier20 ?? []).find((t) => t.subcontractor_id === null)
          ?.price_per_portion ?? null;
      const kitchenTier20s = activeDapurs
        .map(
          (k) =>
            (tier20 ?? []).find((t) => t.subcontractor_id === k.id)
              ?.price_per_portion ?? houseTier20,
        )
        .filter((p): p is number => p != null);
      const cheapest20 =
        kitchenTier20s.length > 0 ? Math.min(...kitchenTier20s) : houseTier20;
      const price20Text = cheapest20
        ? `${Math.round(cheapest20 / 1000)}RB`
        : "";
      const deadlineText = deadlineHour ? `${deadlineHour}.00` : "";

      // With one kitchen there is one menu, one ladder and one set of delivery
      // hours, so everything can go out unasked — which is what the welcome
      // sequence has always done. With more than one none of that is true: the
      // kitchens do not cover the same areas and since migration 098 they do
      // not charge the same prices, so sending all of them means quoting a
      // customer for food nobody near them will cook. Ask where they are first
      // and send the images once the answer narrows it. The greeting itself
      // still goes out immediately — a first contact is never met with silence.
      const askArea = n > 1;

      const resolvedWelcome =
        ((welcomeText ?? "")
          .replace("{{dapur_list}}", dapurListText)
          .replace("{{delivery_areas}}", areasText)
          .replace("{{price_20}}", price20Text)
          .replace("{{order_deadline}}", deadlineText)
          .trim() || dapurListText) +
        (askArea
          ? "\n\nBoleh tahu alamat pengirimannya di area mana kak? Nanti aku kirimkan menu, harga, dan jam kirim dapur yang melayani area itu ya 🙏"
          : "");

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
      const welcomePriceList = askArea
        ? null
        : (activeDapurs[0]?.price_list_image_url ?? priceListUrl);
      if (welcomePriceList) {
        try {
          const conversationId = await saveMessage({
            customerId,
            role: "assistant",
            content: welcomePriceList,
            messageType: "image",
            modelUsed: "system",
          });
          const whatsappMessageId = await sendImageByUrl(
            message.from,
            welcomePriceList,
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
            welcomePriceList.slice(0, 120),
            "error:",
            e,
          );
        }
      }
      for (const sub of askArea ? [] : (welcomeSubs ?? [])) {
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

      // Hours and cooking days belong to the kitchen, not to the business
      // (migrations 093 and 098): Dapur Suplir arrives 11.30-12.30 and works
      // Saturdays, Dapur Monstera arrives 09.00-12.00 and does not. Hardcoding
      // 10.00-12.00 here is how Naya came to be told at 11.09 that her food was
      // late when by her kitchen's own window it was not yet due. One kitchen
      // gets its own numbers; with more than one the T&C says the hours differ
      // and they arrive with that kitchen's menu, because at this point in the
      // conversation we do not know which kitchen is hers.
      const welcomeKitchen = activeDapurs[0] ?? null;
      const deliveryLine = askArea
        ? "🚚 Jam kirim beda per dapur — aku kirimkan bersama menunya ya"
        : `🚚 Pengiriman siang ${deliveryWindow("lunch", welcomeKitchen).label} WIB | malam ${deliveryWindow("dinner", welcomeKitchen).label} WIB`;
      const daysText = askArea ? "" : daysLabel(welcomeKitchen?.delivery_days);
      const tnc = [
        "*Syarat & Ketentuan Pian Yi Catering:*",
        "",
        `📦 Setiap porsi: nasi + lauk + sayur + sambal (mika bento)`,
        deliveryLine,
        `⏰ Batas order & perubahan: jam ${deadlineText} H-1 pengiriman`,
        `💰 Pembayaran di muka sebelum jam ${deadlineText}`,
        `⚠️ Terlambat (siang >12.30 / malam >18.30) → diskon 50%`,
        `🏠 Pesanan selalu digantung di pintu/pagar — kurir tidak menunggu`,
        daysText
          ? `📅 Kirim ${daysText}, tutup di semua hari libur nasional (tanggal merah)`
          : `📅 Tutup di semua hari libur nasional (tanggal merah)`,
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
    justWelcomed,
    latestOrderStatus,
    phone: message.from,
    stateRow,
    text,
    messageId: message.messageId,
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
  // Set only by the webhook path, and only on the request that actually sent
  // the welcome sequence. Draft mode and the replay-latest path leave it false.
  justWelcomed?: boolean;
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
  // write nothing about the customer, and hand the text back so an admin can
  // edit it before it goes out. Every side effect on this path is irreversible
  // from the customer's side, so the rule is: drafting reads the customer and
  // calls the model, and touches nothing else about them. The one thing that
  // does still happen is the circuit breaker recording whether that call
  // succeeded, plus its admin push on an API error — those describe our own
  // infrastructure, not the customer, and a draft that fails on an outage
  // should count like any other failed call. Returns the draft text; normal
  // mode always returns null.
  draft?: boolean;
}): Promise<string | null> {
  const {
    customerId,
    customerName,
    customerNotes,
    justWelcomed = false,
    latestOrderStatus,
    phone,
    stateRow,
    text,
    messageId,
    draft = false,
  } = params;
  const db = createAdminClient();

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
      await db
        .from("customer_flags")
        .update({ is_suspicious: true })
        .eq("customer_id", customerId);
    }
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
  let detectedMapsLink: string | null = findMapsLink(text);
  if (!detectedMapsLink) {
    for (const msg of history) {
      if (msg.role !== "user") continue;
      const msgText = Array.isArray(msg.content)
        ? msg.content
            .map((b) => (typeof b === "object" && "text" in b ? b.text : ""))
            .join(" ")
        : String(msg.content);
      const found = findMapsLink(msgText);
      if (found) {
        detectedMapsLink = found;
        break;
      }
    }
  }

  // A pin in the chat is only worth having if it reaches the record the kitchen
  // sheet reads. It used to sit in the thread and nowhere else: `maps_link` on
  // `extract_order` is filled only when the model passes one, and 266 of 416
  // customers had no link at all on 2026-09-01 — Clairine and Sharleen among
  // them, both of whom typed their address in full and were never asked for a
  // pin. Written once, when the column is empty: an admin who has corrected a
  // link by hand outranks anything found in a chat.
  const { data: storedLinkRow } = await db
    .from("customers")
    .select("google_maps_link")
    .eq("id", customerId)
    .maybeSingle();
  let storedMapsLink = storedLinkRow?.google_maps_link ?? null;
  if (!draft && detectedMapsLink && !storedMapsLink) {
    const { error: linkErr } = await db
      .from("customers")
      .update({ google_maps_link: detectedMapsLink })
      .eq("id", customerId);
    if (!linkErr) {
      storedMapsLink = detectedMapsLink;
      await logEdit({
        db,
        actor: systemActor("webhook-maps-link"),
        entityType: "customer",
        entityId: customerId,
        action: "update",
        changes: { google_maps_link: { from: null, to: detectedMapsLink } },
      });
    }
  }
  // What the prompt is told: the pin on file, else one seen in this thread.
  const mapsLinkOnFile = storedMapsLink ?? detectedMapsLink;

  // Load active dapurs and active order quota in parallel
  const [{ data: activeSubs }, { data: activeOrderRow }] = await Promise.all([
    db
      .from("subcontractors")
      .select(
        "id, customer_nickname, menu_image_url, menu_text, menu_week_start, delivery_areas, offers_size_m, same_menu_both_meals",
      )
      .eq("is_active", true)
      .not("customer_nickname", "is", null),
    db
      .from("orders")
      .select("id, package_size, portions_per_delivery, size, subcontractor_id")
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
      offers_size_m: boolean;
      same_menu_both_meals: boolean;
    } => s.customer_nickname !== null,
  );
  // Only offer a dapur if its menu image has been uploaded
  const dapurOptions = rawSubs
    .filter((s) => !!s.menu_image_url)
    .map((s) => ({
      id: s.id,
      nickname: s.customer_nickname,
      offersM: s.offers_size_m === true,
      sameMenuBothMeals: s.same_menu_both_meals === true,
    }));
  const dapurMenuTexts = rawSubs
    .filter((s) => !!s.menu_image_url && !!s.menu_text)
    .map((s) => ({
      nickname: s.customer_nickname,
      menuText: s.menu_text as string,
    }));
  const servedAreas = unionAreas(rawSubs);
  const neighborhoods = await getNeighborhoods();
  const excludedNeighborhoods = await getExcludedNeighborhoods();
  // Which of those neighborhoods each kitchen refuses, and which cost extra to
  // reach. Read live rather than cached: a kitchen that has just said no must
  // stop being sold to on the next message, not on the next cache refresh.
  const kitchenCoverageNotes = await coverageNotes(db, rawSubs);
  const activeOrder = activeOrderRow
    ? {
        id: activeOrderRow.id,
        packageSize: activeOrderRow.package_size,
        portionsPerDelivery: activeOrderRow.portions_per_delivery,
        // A running S package whose own dapur cooks M. The prompt tells these
        // customers M exists — they bought before the bot volunteered it, and
        // nothing else will ever reach them: 120 of the 129 holding one have a
        // closed 24h window, so a broadcast cannot be sent.
        onSizeSWithMAvailable:
          activeOrderRow.size !== "m" &&
          rawSubs.some(
            (s) =>
              s.id === activeOrderRow.subcontractor_id &&
              s.offers_size_m === true,
          ),
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
    detectedMapsLink: mapsLinkOnFile,
    mapsLinkIsSharedPin: mapsLinkOnFile
      ? isSharedPinLink(mapsLinkOnFile)
      : false,
    justWelcomed,
    menuShown: stateRow?.menu_shown ?? false,
    dapurOptions,
    dapurMenuTexts,
    // Only the kitchens whose image can actually be sent decide the week.
    menuWeek: describeMenuWeeks(
      rawSubs.filter((s) => !!s.menu_image_url).map((s) => s.menu_week_start),
    ),
    servedAreas,
    neighborhoods,
    excludedNeighborhoods,
    coverageNotes: kitchenCoverageNotes,
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
          // The days are part of the order brief, not an optional extra. The
          // schedule used to be optional and the code invented a week from a
          // meal-preference enum whenever it was missing — food on the kitchen
          // sheet for dates nobody had confirmed. `[]` is the answer for a
          // customer who books day by day.
          "delivery_schedule",
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
      name: "delete_deliveries",
      description:
        'Removes dates from the customer\'s delivery schedule — a skip ("besok saya libur dulu ya"), a cancellation of one day, or the first half of moving a meal. The portions go straight back into their balance and can be booked again, so a skip costs the customer nothing. Pass EVERY date the customer named in one call. To MOVE a delivery — siang jadi malam, or hari lain — call this for the old date and record_daily_order for the new one in the same message; this tool only removes. A date marked TERKUNCI in the schedule is refused and nothing on it changes, so never promise a skip for one. Never say a date has been cancelled without calling this: nobody re-reads the thread, and the row stays on the kitchen sheet.',
      input_schema: {
        type: "object",
        properties: {
          delivery_dates: {
            type: "array",
            items: { type: "string" },
            description:
              "Every date to remove as ISO YYYY-MM-DD, resolved yourself from Today. Never a weekday name.",
          },
          meal_type: {
            type: "string",
            enum: ["lunch", "dinner", "both"],
            description:
              'Which meal to remove on those dates. Omit, or "both", to remove everything scheduled that day — which is what a plain skip means. Pass "lunch" or "dinner" only when the customer has both meals that day and is keeping one.',
          },
          reason: {
            type: "string",
            description:
              "Why the customer asked, in their own words. Stored with the deleted row so an admin can put it back.",
          },
        },
        required: ["delivery_dates"],
      },
    },
    {
      name: "ask_admin_for_help",
      description:
        "Called when the bot is uncertain about the answer. Pauses the bot, asks an admin for input, then the bot will send a polished version of that answer to the customer. Use this by default for uncertainty. Do NOT use escalate_to_human unless the customer needs a human to take over entirely. Never name the admin to the customer — the system prompt says which name, if any, may be used.",
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
        "Called when the conversation must be fully handed off to an admin — use only for complaints, refund requests, or clearly frustrated customers. Never name the admin to the customer — the system prompt says which name, if any, may be used.",
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
      name: "record_customer_area",
      description:
        'Saves which delivery area the customer lives in. Call it the moment they name a place — answering "area mana kak?", or naming their neighbourhood, apartment or office anywhere in the conversation — and before you send them a menu, a price list or a price. Which kitchens cook for them is decided by this field, and since every kitchen has its own menu, its own prices and its own delivery hours, sending any of those before it is recorded means quoting food nobody near them will cook. Recording it costs nothing and can be corrected later; it is never a reason to delay a reply.',
      input_schema: {
        type: "object",
        properties: {
          area: {
            type: "string",
            enum: servedAreas,
            description:
              "The served area their address falls in. If they named a place rather than an area, pick the served area it sits in yourself — never ask a second time just to get this exact wording.",
          },
        },
        required: ["area"],
      },
    },
    {
      name: "send_menu_image",
      description:
        "Sends the menu image(s) currently on file. Which week those cover is stated in your system prompt — check it before you describe what you are sending, and do not claim a week the prompt does not say you have. Safe to call even if the menu was previously sent.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "send_delivery_proof",
      description:
        'Sends the customer the delivery photo the kitchen took. Call it whenever they ask whether their food arrived or to see proof of it ("bukti pengiriman", "bukti pengantaran", "foto pengirimannya", "udah dikirim belum", "uda diantar ya"). Leave "date" out for today, which is what they almost always mean; pass it only when they named an earlier day, resolved yourself from Today and never as a weekday name. It answers with the date of the photo it sent — say that date and no other. If it answers that the food has not arrived yet it names the delivery window: tell them that window and that the food is on its way. If it says there is no photo, say so plainly; do not promise one is coming.',
      input_schema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description:
              "ISO date (YYYY-MM-DD) of the delivery the customer is asking about. Omit for today.",
          },
        },
      },
    },
    {
      name: "send_invoice",
      description:
        'Sends the customer their invoice as a PDF. Call it whenever they ask for one ("minta invoice", "invoice dong", "kwitansi", "nota", "bukti pembayaran resmi", "buat laporan kantor"). The document is built from their order — number, portions, price, paid or unpaid — so you never type any of those figures yourself. Never say an invoice is coming without calling this. It covers a plain invoice only: a faktur pajak or anything needing NPWP is still ask_admin_for_help.',
      input_schema: {
        type: "object",
        properties: {
          start_date: {
            type: "string",
            description:
              "ISO date (YYYY-MM-DD) of the first delivery of the package they mean, when they hold more than one and have said which. Omit for their most recent order.",
          },
        },
      },
    },
    {
      name: "send_price_list",
      description:
        "Sends the price list image (harga & area pengiriman). Call it whenever the customer asks for the price list again — the welcome sequence sent it once and nothing else resends it. Safe to call more than once. Never promise the image without calling this.",
      input_schema: { type: "object", properties: {} },
    },
  ];

  // Call the conversational model (with one retry on overload)
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
  const toolResults = new Map<string, ToolResult>();
  // The payment message, held back until this turn's reply has been sent. Every
  // path out of this function from here down has to flush it, or the customer
  // is told their order is being placed and never learns where to transfer.
  const deferredSends: (() => Promise<void>)[] = [];
  const flushDeferred = async () => {
    while (deferredSends.length > 0) {
      const send = deferredSends.shift();
      if (send) await send();
    }
  };
  for (const toolUse of toolUses) {
    const result = await handleToolUse(
      toolUse,
      customerId,
      phone,
      customerName,
    );
    toolResults.set(toolUse.id, result);
    if (result.ok && result.sendPayment) deferredSends.push(result.sendPayment);
    if (!result.ok) {
      console.warn(
        `[webhook] tool ${toolUse.name} did nothing for ${customerId}: ${result.error}`,
      );
    }
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
      // Indonesian, because this string is interpolated straight into the push
      // body and into customer_flags.escalation_reason, both of which an admin
      // reads in the dashboard alongside Indonesian text.
      promised
        ? "bot menjanjikan order tapi tidak membuatnya"
        : looping
          ? "bot berputar-putar bertanya"
          : "balasan tanpa order dibuat",
    );
  }

  // The three claim guards below ask what the customer will *read*, not what
  // the model wrote. sanitizeReply strips the stage directions and the meta
  // brackets the model addresses to itself, and a claim inside one of those
  // never reaches anybody, so recovering from it sends an image nobody was
  // promised. Clairine Aurelia asked "Apa uda diantar kak" on 2026-09-01, was
  // sent her delivery photo, and then got this week's menu image on top of it:
  // her reply carried no visible claim at all — the whole match lived in a
  // bracket the sanitizer had already deleted. The customer-visible text is the
  // only thing that can be a lie.
  const visibleReply = replyText ? sanitizeReply(replyText) : "";

  // The model claims to have sent the menu instead of calling the tool, and the
  // customer is left looking for an image that does not exist. Sending it twice
  // costs nothing; telling someone to check an image we never sent does.
  if (
    visibleReply &&
    !toolUses.some((t) => t.name === "send_menu_image") &&
    claimsMenuSent(visibleReply) &&
    // "berikut foto pengirimannya" reads as a menu claim too. The customer
    // asked for their delivery photo; answering with the week's menu is a
    // second wrong image, so the proof guard below owns that reply.
    !claimsProofSent(visibleReply) &&
    !(await sentImageSinceLastInbound(customerId))
  ) {
    console.log(
      `[webhook] menu claimed but never sent — sending it for ${customerId}`,
    );
    const recovered = await handleToolUse(
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
    // The reply has already gone out claiming the menu was sent, so a failed
    // recovery leaves the same lie standing that the guard exists to catch.
    if (!recovered.ok) {
      await sendPushToAllAdmins(
        `Menu dijanjikan tapi tidak terkirim — ${customerName ?? phone}`,
        recovered.error,
        "/inbox",
        "high",
      ).catch(console.error);
    }
  }

  // The model says the delivery photo is sent and calls no tool. The customer
  // then goes looking for a photo that never left, and this one is worse than
  // the menu: they are usually asking because they are standing in front of a
  // delivery they cannot find. Clairine Aurelia was written to from the second
  // number on 2026-08-31, asked for her proof exactly as the draft told her to,
  // and was answered "kami sudah kirimkan foto buktinya ya kak" with nothing
  // behind it — the one turn the whole Proof Relay hand-off exists to reach.
  //
  // Sending it here is safe: the customer just messaged, so the window is open
  // by definition, and a second copy of a photo they asked for is not a cost.
  //
  // The same guard answers the stall, which is the far more common shape: the
  // model says it is going to look for the photo, or that the food has landed,
  // and ends the turn. Both are claims about a lookup that never happened, both
  // are settled by running it, and running it twice is what a second guard
  // would do — so there is one.
  if (
    visibleReply &&
    !toolUses.some((t) => t.name === "send_delivery_proof") &&
    (claimsProofSent(visibleReply) || claimsProofPending(visibleReply, text))
  ) {
    console.log(
      `[webhook] delivery proof claimed but never sent — sending it for ${customerId}`,
    );
    const recovered = await handleToolUse(
      {
        type: "tool_use",
        id: "proof-claim",
        name: "send_delivery_proof",
        input: {},
        caller: null,
      } as unknown as Anthropic.Messages.ToolUseBlock,
      customerId,
      phone,
      customerName,
    );
    // The reply has already gone out, so a failed recovery leaves its claim
    // standing — and the claim is the thing that hurts. Answer it in the same
    // turn: `customerReply` is the truth about the food, written for the
    // customer rather than for the model, and it is the whole point of the
    // guard. Naya was never told the food had not arrived; she was told five
    // times that someone was looking, which is what a stall sounds like from
    // the other end. Only a real malfunction — a dead signed URL — has no text
    // to send, and that is what an admin has to see.
    if (!recovered.ok) {
      const answer = recovered.customerReply;
      if (answer) {
        const conversationId = await saveMessage({
          customerId,
          role: "assistant",
          content: answer.text,
          modelUsed: "system",
        });
        const whatsappMessageId = await sendTextMessage(phone, answer.text);
        await updateMessageReceipt({
          conversationId,
          whatsappMessageId,
          status: "sent",
        });
      }
      // A photo still inside its delivery window is not news to anybody: the
      // sentence above answers it in full, and pushing every early "sudah
      // sampai belum kak" is how a notification stops being read.
      if (!answer || answer.needsAdmin) {
        await sendPushToAllAdmins(
          `Bukti pengiriman belum ada — ${customerName ?? phone}`,
          recovered.error,
          "/inbox",
          "high",
        ).catch(console.error);
      }
    }
  }

  // The model says the invoice is on its way and calls no tool. The customer
  // then waits for a document nobody built — which is exactly how Carolin's
  // request sat for a day. Sending it here costs nothing: the PDF is derived
  // from an order that already exists, no money moves, and a second copy of an
  // invoice is not a problem the way a second order would be.
  if (
    visibleReply &&
    !toolUses.some((t) => t.name === "send_invoice") &&
    claimsInvoiceSent(visibleReply)
  ) {
    console.log(
      `[webhook] invoice claimed but never sent — sending it for ${customerId}`,
    );
    const recovered = await handleToolUse(
      {
        type: "tool_use",
        id: "invoice-claim",
        name: "send_invoice",
        input: {},
        caller: null,
      } as unknown as Anthropic.Messages.ToolUseBlock,
      customerId,
      phone,
      customerName,
    );
    // The reply claiming it has already gone out, so a failure here is a
    // promise nobody can keep unless a person sees it.
    if (!recovered.ok) {
      await sendPushToAllAdmins(
        `Invoice dijanjikan tapi tidak terkirim — ${customerName ?? phone}`,
        recovered.error,
        "/inbox",
        "high",
      ).catch(console.error);
    }
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
    promisesSchedule(replyText)
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
      const recovered = await handleToolUse(
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
      // record_daily_order pushes on its own for the failures it can name, but
      // not for the ones it only logs — and the customer has already been told
      // the dates are set, so silence here is the worst outcome.
      if (!recovered.ok) {
        await sendPushToAllAdmins(
          `Jadwal dijanjikan tapi tidak tercatat — ${customerName ?? phone}`,
          recovered.error,
          "/deliveries",
          "high",
        ).catch(console.error);
      }
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

  // The model confirms a skip or a move and calls no delete_deliveries. Nothing
  // is deleted, so the row stays on the kitchen sheet, the food is cooked, and
  // the portion is spent on a day the customer was told they had back.
  //
  // Flagged rather than recovered, unlike the guards above: every one of those
  // fixes itself by *sending* something, and a second menu image or a second
  // invoice costs nothing. This one would fix itself by deleting a delivery
  // row, and a date read back out of a reply the model already got wrong is not
  // a good enough reason to destroy the only record of a meal — deleteDelivery
  // copies the row to edit_log because nothing else can rebuild it. An admin
  // decides.
  if (
    replyText &&
    !toolUses.some((t) => t.name === "delete_deliveries") &&
    claimsSkipDone(replyText)
  ) {
    const { data: flags } = await db
      .from("customer_flags")
      .select("needs_human_review")
      .eq("customer_id", customerId)
      .maybeSingle();
    // One push per unresolved flag, as flagOrderAtRisk does: an admin who has
    // already been told does not need telling again on the customer's next
    // message.
    if (flags?.needs_human_review !== true) {
      const scheduled =
        schedule && schedule.upcoming.length > 0
          ? schedule.upcoming
              .map(
                (d) =>
                  `${d.date} ${d.mealType === "dinner" ? "malam" : "siang"}`,
              )
              .join(", ")
          : "tidak ada pengiriman terjadwal";
      const note = `Bot menyanggupi skip/pindah jadwal tanpa memanggil delete_deliveries. Jadwal yang masih tercatat: ${scheduled}`;
      console.warn(
        `[webhook] skip confirmed but never deleted for ${customerId} — ${scheduled}`,
      );
      await db
        .from("customer_flags")
        .update({
          needs_human_review: true,
          escalation_reason: note,
        })
        .eq("customer_id", customerId);
      await sendPushToAllAdmins(
        `Skip dijanjikan tapi tidak dihapus — ${customerName ?? phone}`,
        note,
        "/inbox",
        "high",
      ).catch(console.error);
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
              // The real outcome, not the literal "done" this used to send for
              // every tool regardless of whether it wrote anything.
              content: JSON.stringify(
                toolResults.get(t.id) ?? {
                  ok: false,
                  error: "Tool tidak dijalankan.",
                },
              ),
              is_error: toolResults.get(t.id)?.ok === false,
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
      // The reply is dropped, but the order behind it was written and the
      // customer still has to be told where to pay.
      await flushDeferred();
      return null;
    }
  }

  let replyModelUsed = modelTag("sonnet");

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
            remainingToday: schedule?.remainingToday ?? 0,
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
    const beforeSanitize = replyText;
    replyText = sanitizeReply(replyText);

    // The sanitizer emptied it: every paragraph was the model reasoning at
    // itself, so there was never an answer underneath. Send the same fallback a
    // twice-rejected reply gets and put the thread in front of an admin — the
    // customer is owed a reply, and a blank one is the bug this guard exists to
    // stop shipping.
    if (!replyText.trim() && beforeSanitize.trim()) {
      console.warn(
        "[webhook] reply was reasoning only, falling back:",
        beforeSanitize,
      );
      replyText = await getTemplate("reply_validation_fallback");
      replyModelUsed = "system";
      await db
        .from("customer_flags")
        .update({
          pending_bot_response: true,
          pending_bot_question:
            "Auto-flagged: bot reply was reasoning only, needs review",
        })
        .eq("customer_id", customerId);
      await sendPushToAllAdmins(
        "Reply blocked — reasoning leak",
        `${customerName ?? phone}`,
        "/inbox",
        "high",
      );
    }

    // A weekday the model wrote next to a date it did not check. Runs on the
    // cleaned text so it also catches a translated or retried reply, and
    // before the send so the customer and the inbox see the same corrected
    // sentence. See src/lib/claude/fix-dates.ts.
    replyText = fixWeekdayNames(replyText, jakartaDateString());

    // The conversation may have moved on while this turn was thinking. If it
    // has, the turn answering the newer message loads the whole burst as its
    // history and covers this one too, so sending both stacks two replies on
    // the customer — see supersededByNewerMessage.
    //
    // Only a turn that called no tool may be dropped. One that wrote something
    // has an outcome to report that the later turn cannot know it produced,
    // and silence after a booking is worse than a second message.
    if (
      !draft &&
      messageId &&
      toolUses.length === 0 &&
      !isDemoPhone(phone) &&
      (await supersededByNewerMessage(db, customerId, messageId))
    ) {
      console.log(
        `[webhook] reply for ${messageId} superseded while generating, dropped`,
      );
      return null;
    }

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

  // Last, so the bank details are the last thing the customer reads. Also
  // covers the turn that produced no text at all — the order still has to be
  // payable.
  await flushDeferred();

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

  // The payer's proof covers every order they are paying for, not only the one
  // in their own name. A package bought for someone else sits on the
  // beneficiary, with the buyer in `paid_by_customer_id` — so matching on
  // customer_id alone leaves the friend's order in pending_payment with no
  // signal that anything arrived. Naya sent one transfer proof on 2026-08-30
  // for her 20-porsi package and Cila's 5, only her own flipped, and
  // cancel-unpaid was four hours from sweeping Cila's the evening before its
  // start date.
  await db
    .from("orders")
    .update({
      status: "payment_proof_received",
      payment_proof_url: imageUrl,
      payment_proof_received_at: new Date().toISOString(),
    })
    .or(`customer_id.eq.${customerId},paid_by_customer_id.eq.${customerId}`)
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

/**
 * What a tool actually did, in the words the model is allowed to repeat.
 *
 * Every branch of handleToolUse used to return void, and the follow-up call
 * that asks the model for the text to go with a tool call fed it the literal
 * string "done" for every tool. record_daily_order alone has eight ways to
 * write nothing — no valid date, no active order, no draw order, no unbooked
 * quota, every date a holiday, nothing left after dedup, an insert error —
 * and each of them reached the model as success, so it could answer "sudah
 * tercatat kak" over an empty calendar. The messages are Indonesian because
 * the model paraphrases them straight into its reply.
 */
type ToolResult =
  | {
      ok: true;
      message: string;
      /**
       * Work the caller must run after it has sent its own reply. Only
       * `extract_order` sets it, and only to hold the payment message back
       * until the sentence introducing it has gone out — see
       * `deferPaymentMessage` in `createOrderFromExtraction`.
       */
      sendPayment?: (() => Promise<void>) | null;
    }
  | {
      ok: false;
      error: string;
      /**
       * What to say to the customer, when the failure is an answer rather than
       * a malfunction. `error` is written for the model and carries stage
       * directions it must never repeat ("jangan janjikan fotonya menyusul"),
       * so a guard recovering a reply that has already gone out cannot forward
       * it; only send_delivery_proof fills this, because "we hold no photo" is
       * the answer to the customer's question, not a broken tool.
       * `needsAdmin` is false while the answer is complete on its own — the
       * food is simply still in its delivery window — and true when a person
       * has to go and ask the kitchen.
       */
      customerReply?: { text: string; needsAdmin: boolean };
    };

/**
 * What to tell the model when we hold no photo for a date.
 *
 * "Belum ada fotonya" is the wrong answer while the courier is still out: the
 * food has not arrived yet, and a customer hearing we have no proof of it hears
 * that their delivery is missing. So a scheduled date whose window has not
 * closed gets the window quoted back instead. Clairine and Julian S both asked
 * on 2026-09-01 shortly after 16:00, with their dinner rows on the sheet and
 * the 16.00-18.00 window still running.
 */
async function noProofReason(
  customerId: string,
  date: string,
): Promise<{ model: string; customer: string; needsAdmin: boolean }> {
  const db = createAdminClient();
  const [{ data: rows }, { data: customer }] = await Promise.all([
    db
      .from("daily_deliveries")
      .select("meal_type, subcontractor_id")
      .eq("customer_id", customerId)
      .eq("delivery_date", date),
    db
      .from("customers")
      .select("collects_from_courier")
      .eq("id", customerId)
      .maybeSingle(),
  ]);
  // The window is the kitchen's, not the meal's: Thenie finishes lunch at
  // 12.30 and the default says 12.00, which is the half hour Naya spent being
  // told her food was late.
  const kitchens = await loadKitchenWindows(
    db,
    (rows ?? []).map((r) => r.subcontractor_id),
  );
  const windowOf = (r: {
    meal_type: string;
    subcontractor_id: string | null;
  }) =>
    deliveryWindow(
      r.meal_type,
      r.subcontractor_id ? kitchens.get(r.subcontractor_id) : null,
    );

  if (!rows?.length)
    return {
      model: `Tidak ada pengiriman terjadwal untuk tanggal ${date}, jadi tidak ada fotonya. Bilang apa adanya dan sebutkan tanggal itu memang tidak ada kirimannya; jangan janjikan foto menyusul.`,
      customer: `Kak, di tanggal ${formatHolidayDate(date)} tidak ada jadwal pengiriman untuk kakak, jadi tidak ada makanan yang diantar hari itu. Kalau menurut kakak seharusnya ada, tulis di sini ya — sudah aku teruskan ke tim kami juga.`,
      needsAdmin: true,
    };

  const today = jakartaDateString();
  const stillOut = rows.filter(
    (r) =>
      date > today ||
      (date === today && jakartaMinuteOfDay() < windowOf(r).endMin),
  );

  if (stillOut.length > 0) {
    const windows = stillOut
      .map(
        (r) =>
          `${r.meal_type === "dinner" ? "makan malam" : "makan siang"} jam ${windowOf(r).label}`,
      )
      .join(" dan ");
    return {
      model: `Belum ada fotonya karena kirimannya memang belum sampai — jam antarnya ${windows} dan sekarang baru jam ${jakartaTimeString()} WIB. Bilang makanannya masih dalam perjalanan dan sebutkan jam antar itu. Jangan bilang tidak ada bukti pengiriman, dan jangan janjikan fotonya menyusul.`,
      customer: `Kak, makanannya belum sampai — masih dalam perjalanan. Jam antarnya ${windows}, sekarang jam ${jakartaTimeString()} WIB.`,
      needsAdmin: false,
    };
  }

  // A customer who meets the courier is never told the food did not come.
  // Synergy Building refuses a lobby drop, so Naya, Cila and Winy take the box
  // from the courier's hand; he photographs what he leaves and not what he
  // hands over, so 2 of Naya's first 3 deliveries have no photo and both were
  // eaten. All we can say is that we hold no picture of it.
  if (customer?.collects_from_courier)
    return {
      model: `Tidak ada foto pengiriman untuk tanggal ${date}, tapi customer ini mengambil makanannya langsung dari kurir jadi fotonya sering memang tidak ada — jangan bilang makanannya belum diantar. Bilang kita belum terima fotonya, tanyakan apakah kurirnya sudah menghubungi, dan tawarkan cek ke tim lewat ask_admin_for_help.`,
      customer: `Kak, aku belum terima foto pengirimannya untuk tanggal ${formatHolidayDate(date)} — kurirnya memang nggak selalu foto kalau serah terima langsung ke kakak. Kurirnya sudah menghubungi kakak belum? Sudah aku teruskan ke tim kami juga ya.`,
      needsAdmin: true,
    };

  // Plainly not delivered, in those words. What a customer standing in a lobby
  // needs is the state of their food, and the two facts behind why we cannot
  // just look: there is no live tracking, and the courier is the partner
  // kitchen's, reachable only through that kitchen's admin. Naming the kitchen
  // is never allowed, so it stays "dapur partner kami".
  return {
    model: `Tidak ada foto pengiriman untuk tanggal ${date} — belum pernah dikirim dapur ke kami. Bilang apa adanya: makanannya belum diantar. Jangan janjikan fotonya menyusul dan jangan bilang sedang dicek dulu; tawarkan cek ke tim lewat ask_admin_for_help.`,
    customer: `Kak, makanannya belum sampai ya — belum ada foto pengiriman dari dapur partner kami untuk tanggal ${formatHolidayDate(date)}. Kami belum punya pelacakan langsung, dan kurirnya kurir dapur partner kami, jadi aku nggak bisa menghubungi kurirnya sendiri — harus lewat admin dapur partner dulu. Sudah aku teruskan ke tim kami sekarang ya, maaf banget kak.`,
    needsAdmin: true,
  };
}

async function handleToolUse(
  tool: Anthropic.Messages.ToolUseBlock,
  customerId: string,
  phone: string,
  customerName: string | null,
): Promise<ToolResult> {
  const db = createAdminClient();

  if (tool.name === "extract_order") {
    const { sendPayment, order } = await createOrderFromExtraction(
      customerId,
      phone,
      await applyLatestCustomerSize(
        customerId,
        tool.input as ExtractedOrderInput,
      ),
      { deferPaymentMessage: true },
    );
    // An order is not always written — one is withheld when the delivery days
    // or a beneficiary's number are missing, and the system asks the customer
    // itself — so say only what is true either way.
    //
    // When one *was* written, its real figures go back to the model. They are
    // not always the ones it asked for: an unsellable schedule sum falls back
    // to package_size, an M order at a dapur that cannot cook M is written as
    // S, and a contract rate ignores the ladder. Withholding them cost real
    // money on 2026-08-31 — the model had quoted Rachel 4 porsi / Rp 116.000,
    // the order was created at 5 porsi / Rp 145.000, and asked which was right
    // it told her to ignore the system's amount and transfer its own.
    //
    // The bank account number is still never in here. That is the rule this
    // one used to be lumped in with.
    return {
      ok: true,
      message: order
        ? `Order tercatat: *${order.packageSize} porsi* (size ${order.size.toUpperCase()}), Rp ${order.pricePerPortion.toLocaleString("id-ID")}/porsi, total *Rp ${order.totalPrice.toLocaleString("id-ID")}*. Sistem yang mengirim detail transfer ke customer setelah balasan ini — jangan tulis nomor rekening dan jangan ulangi nominalnya kecuali customer bertanya. Kalau angka ini beda dari yang kamu sebut tadi, angka inilah yang benar: akui saja apa adanya dan jelaskan kenapa (misalnya paket minimal ${await minPackageSize()} porsi), jangan pernah menyuruh customer mengabaikan nominal yang dikirim sistem.`
        : "extract_order dijalankan, tapi ordernya belum tercatat — ada data yang kurang dan sistem sudah menanyakannya sendiri ke customer. Jangan sebut nominal atau nomor rekening.",
      sendPayment,
    };
  } else if (tool.name === "record_daily_order") {
    return recordDailyOrder({
      db,
      customerId,
      phone,
      customerName,
      input: tool.input as RecordDailyOrderInput,
    });
  } else if (tool.name === "delete_deliveries") {
    return deleteDeliveries({
      db,
      customerId,
      phone,
      customerName,
      input: tool.input as DeleteDeliveriesInput,
    });
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
    return {
      ok: true,
      message:
        "Pertanyaan sudah diteruskan ke admin, dan customer sudah diberi tahu untuk menunggu. Jangan jawab pertanyaan itu sendiri.",
    };
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
    return {
      ok: true,
      message: "Thread sudah dialihkan ke admin.",
    };
  } else if (tool.name === "mark_payment_proof_received") {
    // Same reach as the image path above: a buyer's proof covers the packages
    // they bought for other people too.
    await db
      .from("orders")
      .update({
        status: "payment_proof_received",
        payment_proof_received_at: new Date().toISOString(),
      })
      .or(`customer_id.eq.${customerId},paid_by_customer_id.eq.${customerId}`)
      .eq("status", "pending_payment");

    await sendPushToAllAdmins(
      "Payment proof received",
      `From ${customerName ?? phone}`,
      "/payments",
      "medium",
    );
    return {
      ok: true,
      message:
        "Bukti bayar dicatat, order menunggu verifikasi admin. Jangan bilang pembayaran sudah dikonfirmasi.",
    };
  } else if (tool.name === "record_customer_name") {
    // Before this tool existed the bot had no way to write a name outside of
    // extract_order, so when +6285692715738 answered "keira" on 2026-08-26 it
    // replied "nama kakak sudah saya catat sebagai Keira" and wrote nothing —
    // the same empty claim docs/BOT_RULES.md forbids for orders.
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
      return { ok: true, message: `Nama customer dicatat sebagai "${given}".` };
    }
    return {
      ok: false,
      error: `Nama "${given}" tidak dicatat — tidak lolos pemeriksaan nama. Jangan bilang namanya sudah dicatat.`,
    };
  } else if (tool.name === "record_customer_area") {
    // Before this tool the area was only ever written by extract_order, which
    // runs at the very end — so for the whole conversation that decides what
    // the customer is quoted, we knew nothing about where they live and every
    // active kitchen's menu and ladder went out. With three kitchens that is a
    // customer being shown Rp 45.000 a portion from a kitchen that does not
    // reach them.
    const input = tool.input as { area?: string };
    const given = (input.area ?? "").trim();
    const served = await activeDeliveryAreas(db);
    const matched = served.find((a) => a.toLowerCase() === given.toLowerCase());
    if (!matched) {
      return {
        ok: false,
        error: `Area "${given}" tidak dicatat — bukan salah satu area yang kami layani (${served.join(", ")}). Jangan bilang areanya sudah dicatat.`,
      };
    }
    const { data: current } = await db
      .from("customers")
      .select("area")
      .eq("id", customerId)
      .single();
    if (current?.area !== matched) {
      await db.from("customers").update({ area: matched }).eq("id", customerId);
      await logEdit({
        db,
        actor: "system:webhook:record_customer_area",
        entityType: "customers",
        entityId: customerId,
        action: "update",
        changes: { area: { from: current?.area ?? null, to: matched } },
      });
    }
    const kitchens = await kitchensForCustomer(db, customerId);
    const names = kitchens
      .map((k) => k.customer_nickname)
      .filter((n): n is string => !!n);
    return {
      ok: true,
      message:
        names.length > 0
          ? `Area customer dicatat sebagai "${matched}". Dapur yang melayani area itu: ${names.join(", ")}. Kirim menu dan price list-nya sekarang dengan send_menu_image dan send_price_list.`
          : `Area customer dicatat sebagai "${matched}".`,
    };
  } else if (tool.name === "send_menu_image") {
    // Only the kitchens that would actually cook for this customer. Inactive
    // kitchens keep their last menu_image_url forever and nobody refreshes it
    // once they stop cooking, so `kitchensForCustomer` filtering on is_active
    // is also what stops a months-old menu from a kitchen we no longer use
    // going out beside the live one.
    const menuSubs = (await kitchensForCustomer(db, customerId)).filter(
      (s) => !!s.menu_image_url,
    );
    for (const sub of menuSubs) {
      const menuUrl = sub.menu_image_url as string;
      // The week goes on the picture itself, so the customer reads it off the
      // caption no matter what the model types underneath. Per kitchen, not
      // from describeMenuWeeks: that collapses to "unknown" the moment two
      // kitchens hold different batches, and each caption is only ever a claim
      // about its own image.
      const subWeek = sub.menu_week_start
        ? formatMenuWeekRange(sub.menu_week_start)
        : null;
      const conversationId = await saveMessage({
        customerId,
        role: "assistant",
        content: menuUrl,
        messageType: "image",
        modelUsed: "system",
      });
      const whatsappMessageId = await sendImageByUrl(
        phone,
        menuUrl,
        [
          sub.customer_nickname ? `Menu ${sub.customer_nickname}` : "Menu Dapur",
          subWeek,
        ]
          .filter(Boolean)
          .join(" — "),
      );
      await updateMessageReceipt({
        conversationId,
        whatsappMessageId,
        status: "sent",
      });
    }
    if (menuSubs.length === 0) {
      console.error(
        "[webhook] send_menu_image: no kitchen serving this customer has a menu",
      );
      return {
        ok: false,
        error:
          "Tidak ada gambar menu yang terkirim — belum ada dapur aktif yang punya menu. Jangan bilang menunya sudah dikirim.",
      };
    }
    // The image goes out before the model writes the text that accompanies it,
    // so this result is the one fresh fact the follow-up turn has about what the
    // customer is now looking at. A bare count is week-blind: on 2026-09-05 the
    // bot sent Batch 53 (7–12 September) to Evelyn Sunrise and then, in the same
    // turn, told her that week's menu "belum rilis" and that the picture covered
    // 14–19 September. Naming the week here is what makes that contradiction
    // cost the model something.
    const sentWeek = describeMenuWeeks(menuSubs.map((s) => s.menu_week_start));
    return {
      ok: true,
      message: menuSentToolMessage(menuSubs.length, sentWeek.weekStart),
    };
  } else if (tool.name === "send_delivery_proof") {
    // The photo lives in a private bucket and is linked to the customer by
    // delivery_proofs.matched_customer_id — matched_delivery_id and
    // daily_deliveries.delivery_proof_id are NULL on all 587 rows, so the
    // customer is the only join that exists. Date filtering is therefore done
    // on received_at, which is when the kitchen sent it to us: the same day it
    // was delivered.
    // A customer asking whether their food arrived means today, so the lookup
    // is always date-bounded. It used to fall back to the newest photo we hold
    // when the model passed no date: on 2026-09-01 at 16:22, inside the
    // 16.00-18.00 dinner window and before tonight's food had left, Clairine
    // asked "Apa uda diantar kak" and was sent 31 Agustus's photo as if it were
    // hers.
    const wanted =
      (tool.input as { date?: string }).date?.trim() || jakartaDateString();
    const { data: proof } = await db
      .from("delivery_proofs")
      .select("id, image_url, received_at")
      .eq("matched_customer_id", customerId)
      .not("image_url", "is", null)
      .gte("received_at", `${wanted}T00:00:00+07:00`)
      .lt("received_at", `${wanted}T23:59:59.999+07:00`)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!proof?.image_url) {
      const reason = await noProofReason(customerId, wanted);
      return {
        ok: false,
        error: reason.model,
        customerReply: { text: reason.customer, needsAdmin: reason.needsAdmin },
      };
    }

    const storagePath = proof.image_url.split("/delivery-proofs/")[1];
    const { data: signed } = storagePath
      ? await db.storage
          .from("delivery-proofs")
          // Long enough for Meta to fetch it, short enough that the link in the
          // logs is dead by the time anyone reads them.
          .createSignedUrl(storagePath, 600)
      : { data: null };
    if (!signed?.signedUrl) {
      console.error(
        `[webhook] send_delivery_proof: cannot sign ${proof.image_url.slice(0, 120)}`,
      );
      return {
        ok: false,
        error:
          "Foto pengirimannya gagal diambil dari penyimpanan. Jangan bilang sudah dikirim; minta bantuan tim lewat ask_admin_for_help.",
      };
    }

    // The customer asked, so their 24h window is open by definition and this
    // goes as a plain image. The Proofs tab uses the delivery_proof template
    // because it fires unprompted, and a template send is what 131042 blocks
    // once a window has closed — the free-form path has no such problem.
    // received_at is nullable in the schema and filled on every row; a null
    // one still has a sendable photo, so the caption drops the date rather
    // than the send.
    const day = proof.received_at?.slice(0, 10) ?? wanted;
    const caption = `Ini foto pengiriman kakak tanggal ${formatHolidayDate(day)} 😊`;
    const conversationId = await saveMessage({
      customerId,
      role: "assistant",
      content: proof.image_url,
      messageType: "image",
      modelUsed: "system",
    });
    const whatsappMessageId = await sendImageByUrl(
      phone,
      signed.signedUrl,
      caption,
    );
    await updateMessageReceipt({
      conversationId,
      whatsappMessageId,
      status: "sent",
    });
    // The proof row keeps the record of the send the kitchen's photo was
    // originally pushed with; a resend on request is a different event and
    // must not overwrite it.
    await logEdit({
      db,
      actor: "system:webhook:send_delivery_proof",
      entityType: "delivery_proofs",
      entityId: proof.id,
      action: "resend_on_request",
      changes: { customer_id: customerId, delivery_date: day },
    });
    // The date goes back to the model as well as onto the photo, so a reply
    // that names a day cannot name a different one from the picture.
    return {
      ok: true,
      message: `Foto pengiriman tanggal ${day} sudah dikirim ke customer.`,
    };
  } else if (tool.name === "send_price_list") {
    // A corporate rate replaces the whole ladder, so the image is wrong for
    // them — the prompt already says never to send it, and this is the half
    // that holds when the model forgets.
    const { data: rateRow } = await db
      .from("customers")
      .select("contract_price_per_portion")
      .eq("id", customerId)
      .maybeSingle();
    if (rateRow?.contract_price_per_portion) {
      return {
        ok: false,
        error:
          "Price list tidak dikirim — customer ini punya harga kontrak, jadi daftar harga umum tidak berlaku untuknya. Sebutkan harga kontraknya, jangan janjikan gambar.",
      };
    }
    // One sheet per kitchen that would cook for this customer. Each kitchen
    // has its own ladder since migration 098, so the single global image is
    // only right for a kitchen with no rows of its own — it reads Rp 29.000 at
    // the bottom tier where Dapur Monstera charges Rp 45.000. A kitchen whose
    // own sheet has not been rendered yet still falls back to it, and the
    // dedupe keeps two such kitchens from sending the same picture twice.
    const houseUrl = await getSetting("price_list_image_url");
    const kitchens = await kitchensForCustomer(db, customerId);
    const sheets: { url: string; nickname: string | null }[] = [];
    for (const k of kitchens) {
      const url = k.price_list_image_url ?? houseUrl;
      if (!url) continue;
      if (sheets.some((s) => s.url === url)) continue;
      sheets.push({
        url,
        nickname: k.price_list_image_url ? k.customer_nickname : null,
      });
    }
    if (sheets.length === 0) {
      console.error("[webhook] send_price_list: no price list image to send");
      return {
        ok: false,
        error:
          "Gambar price list tidak terkirim — belum ada gambarnya. Jangan bilang gambarnya sudah atau akan dikirim; tulis harganya sebagai teks.",
      };
    }
    for (const sheet of sheets) {
      const conversationId = await saveMessage({
        customerId,
        role: "assistant",
        content: sheet.url,
        messageType: "image",
        modelUsed: "system",
      });
      const whatsappMessageId = await sendImageByUrl(
        phone,
        sheet.url,
        sheet.nickname ? `Harga ${sheet.nickname}` : "Harga & Area Pengiriman",
      );
      await updateMessageReceipt({
        conversationId,
        whatsappMessageId,
        status: "sent",
      });
    }
    return {
      ok: true,
      message:
        sheets.length === 1
          ? "Gambar price list sudah dikirim ke customer."
          : `${sheets.length} gambar price list sudah dikirim ke customer, satu per dapur.`,
    };
  } else if (tool.name === "send_invoice") {
    const input = tool.input as { start_date?: string };
    try {
      const result = await sendInvoice({
        db,
        customerId,
        phone,
        startDate: input.start_date,
        actor: systemActor("bot-invoice"),
      });
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        message: `Invoice ${result.number} sudah dikirim ke customer sebagai PDF, total Rp ${result.total.toLocaleString("id-ID")}. Boleh sebut nomor invoice-nya; jangan tulis ulang nomor rekening.`,
      };
    } catch (err) {
      // The PDF, the upload and the WhatsApp send are three things that can
      // fail, and the model must not tell the customer to look for a document
      // that never arrived.
      console.error("[webhook] send_invoice failed:", err);
      return {
        ok: false,
        error:
          "Invoice gagal dibuat, jadi tidak ada dokumen yang terkirim. Jangan bilang invoice sudah atau sedang dikirim — bilang saja sedang dicek tim dan akan menyusul.",
      };
    }
  }

  console.error(`[webhook] handleToolUse: unknown tool ${tool.name}`);
  return {
    ok: false,
    error: `Tool "${tool.name}" tidak ada, jadi tidak ada yang dikerjakan.`,
  };
}

export const dynamic = "force-dynamic";
