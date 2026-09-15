/**
 * Sends one reply composed by the chat-review cron, through the same checks
 * every bot reply passes.
 *   tsx scripts/reply-chat.ts +62... "text" [--apply] [--hold-hours N]
 *
 * The cron (every 2 hours) reads the threads, decides what each waiting
 * customer needs, and sends it from here. Unlike `scripts/manual-send.ts`,
 * where a person has already read what they typed, nothing human sees this
 * text before the customer does — so it runs the bot's own pipeline before it
 * goes out:
 *
 *   sanitizeReply()  strips the stage directions, retractions and duplicate
 *                    paragraphs a model leaves in prose
 *   looksEnglish()   refuses an English reply; customers are written to in
 *                    Indonesian, always
 *   validateReply()  checks every customer-specific claim — quota, package
 *                    size, order and payment status — against the ledger, and
 *                    refuses the send if one is unsupported
 *
 * A refusal is not a failure: it means the reply claimed something the data
 * does not show, and the right response is to rewrite it or leave the thread
 * to a person. The window check in `sendHumanMessage()` is what stops a send
 * that WhatsApp would reject anyway (131042).
 */
import { loadValidationTranscript } from "../src/lib/claude/conversation";
import { looksEnglish } from "../src/lib/claude/language";
import { sanitizeReply } from "../src/lib/claude/sanitize-reply";
import { validateReply } from "../src/lib/claude/validate-reply";
import { logEdit } from "../src/lib/audit/log-edit";
import { loadCustomerSchedule } from "../src/lib/orders/customer-schedule";
import { createAdminClient } from "../src/lib/supabase/admin";
import {
  sendHumanMessage,
  windowHoursOpen,
} from "../src/lib/whatsapp/send-human-message";

const ACTOR = "script:review-reply";
const MAX_HOLD_HOURS = 2;
const PAID_STATUSES = ["active", "paused", "completed"];

async function main() {
  const [phone, raw] = process.argv.slice(2);
  if (!phone?.startsWith("+") || !raw) {
    throw new Error('usage: reply-chat.ts +62... "text" [--apply]');
  }
  const apply = process.argv.includes("--apply");
  const holdFlag = process.argv.indexOf("--hold-hours");
  const holdHours = holdFlag === -1 ? 0 : Number(process.argv[holdFlag + 1]);
  if (holdHours < 0 || holdHours > MAX_HOLD_HOURS || Number.isNaN(holdHours)) {
    throw new Error(`--hold-hours must be 0..${MAX_HOLD_HOURS}`);
  }

  const db = createAdminClient();
  const { data: cust, error } = await db
    .from("customers")
    .select("id, name, notes")
    .eq("phone_number", phone)
    .single();
  if (error) throw new Error(error.message);
  // `new`/`ordering`/`lapsed`/`churned` lives in its own table, not on the
  // customer row, and the validator reads it to judge order-status claims.
  const { data: stateRow } = await db
    .from("customer_state")
    .select("state")
    .eq("customer_id", cust.id)
    .maybeSingle();

  const hours = await windowHoursOpen(phone);
  console.log(
    `${cust.name ?? "(no name)"} ${phone} — window ${hours < 24 ? "OPEN" : "SHUT"} (${hours.toFixed(1)}h)`,
  );
  if (hours >= 24) throw new Error("window shut — this one needs the manual number");

  const text = sanitizeReply(raw);
  if (!text.trim()) throw new Error("nothing left after sanitizeReply");
  if (text !== raw) console.log(`\nsanitized:\n${text}`);
  if (looksEnglish(text)) throw new Error("reply looks English — rewrite in Indonesian");

  const schedule = await loadCustomerSchedule(db, cust.id);
  const { data: orders } = await db
    .from("orders")
    .select("package_size")
    .eq("customer_id", cust.id)
    .in("status", PAID_STATUSES);
  const packageSize = (orders ?? []).reduce(
    (sum, o) => sum + (o.package_size ?? 0),
    0,
  );

  const verdict = await validateReply({
    reply: text,
    customerName: cust.name,
    customerNotes: cust.notes,
    customerState: stateRow?.state ?? "new",
    activeOrder: schedule
      ? {
          unbooked: schedule.unbooked,
          packageSize,
          remainingToday: schedule.remainingToday,
        }
      : null,
    transcript: await loadValidationTranscript(cust.id),
  });
  if (!verdict.valid) {
    console.error("\nBLOCKED — unsupported claims:");
    for (const claim of verdict.unsupportedClaims) console.error(`  - ${claim}`);
    throw new Error("validator refused the reply");
  }
  console.log("validator: ok");

  if (!apply) return console.log(`\n${text}\n\ndry run — pass --apply`);

  const sent = await sendHumanMessage({ phone, text, sentBy: ACTOR, holdHours });
  await logEdit({
    db,
    actor: ACTOR,
    entityType: "conversations",
    entityId: sent.conversationId ?? cust.id,
    action: "send_review_reply",
    changes: { phone, text, holdHours, windowHours: Number(hours.toFixed(1)) },
  });
  console.log(
    `sent — ${sent.whatsappMessageId}${holdHours ? ` — bot held ${holdHours}h` : ""}`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
