/**
 * Sends one hand-written message to a customer and logs it to conversations,
 * the way the inbox compose box does. For driving a thread the bot has parked.
 *   tsx scripts/manual-send.ts +62... "text" [--apply] [--hold-hours N]
 *
 * The send itself lives in `sendHumanMessage()`, shared with
 * `scripts/reply-chat.ts`. What a person types is not validated here — this
 * script exists precisely for the cases the bot cannot be trusted with.
 */
import {
  sendHumanMessage,
  windowHoursOpen,
} from "../src/lib/whatsapp/send-human-message";

// Longest a thread may be held from here, matching the inbox's own menu. A hold
// is for waiting on something that happens today — a transfer, a courier, a
// decision — and one that outlives that is how a customer ends up talking to
// nobody. It was 24 until 2026-09-09, when a hold set here at 19:28 WIB was
// still silencing Sherine Fayola's thread the next morning, hours after the
// complaint it was taken for had been settled.
const MAX_HOLD_HOURS = 2;

async function main() {
  const [phone, text] = process.argv.slice(2);
  const apply = process.argv.includes("--apply");
  const holdFlag = process.argv.indexOf("--hold-hours");
  const holdHours = holdFlag === -1 ? 0 : Number(process.argv[holdFlag + 1]);
  if (holdHours < 0 || holdHours > MAX_HOLD_HOURS || Number.isNaN(holdHours)) {
    throw new Error(`--hold-hours must be 0..${MAX_HOLD_HOURS}`);
  }

  const hours = await windowHoursOpen(phone);
  console.log(
    `${phone} — window ${hours < 24 ? "OPEN" : "SHUT"} (${hours.toFixed(1)}h)\n${text}\n`,
  );
  if (!apply) return console.log("dry run — pass --apply");

  const sent = await sendHumanMessage({
    phone,
    text,
    sentBy: "script:manual-send",
    holdHours,
  });
  console.log(
    `sent to ${sent.customerName ?? "(no name)"} — ${sent.whatsappMessageId}${holdHours ? ` — bot held ${holdHours}h` : ""}`,
  );
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
