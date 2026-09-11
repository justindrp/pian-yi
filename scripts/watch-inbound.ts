/**
 * Prints one line per inbound message on one customer's thread, forever.
 *
 *   tsx --env-file=.env.local scripts/watch-inbound.ts +62...
 *
 * For a thread held off the bot with no auto-resume. A hold with no watcher is
 * the Sherine Fayola failure — the bot is gagged, nothing tells anyone the
 * customer wrote, and she talks to nobody for hours. Every line here is a
 * message somebody has to answer by hand.
 *
 * Generalises scripts/watch-vania.ts, which is the same loop hardcoded to one
 * customer. Not scripts/watch-thread.ts, which is a one-shot dump of a thread
 * and its orders. stdout is the whole interface, one line per message, so it can be
 * read by a person tailing it or by a monitor that turns each line into a
 * notification.
 */
import { createAdminClient } from "../src/lib/supabase/admin";

const POLL_MS = 30_000;
/** ~5 minutes of dead polls. Long enough to ride out a blip, short enough to notice. */
const MAX_FAILURES = 10;

async function main() {
  const phone = process.argv[2];
  if (!phone) throw new Error("usage: watch-inbound.ts +62...");

  const db = createAdminClient();
  const { data: cust } = await db
    .from("customers")
    .select("id, name")
    .eq("phone_number", phone)
    .single();
  if (!cust) throw new Error(`no customer ${phone}`);

  const who = cust.name ?? phone;
  // Start from now: the backlog has already been read by whoever started this.
  let cursor = new Date().toISOString();
  let failures = 0;
  console.log(`watching ${who} — every inbound needs a human`);

  for (;;) {
    const poll = () =>
      db
        .from("conversations")
        .select("created_at, content, message_type")
        .eq("customer_id", cust.id)
        .eq("role", "user")
        .gt("created_at", cursor)
        .order("created_at");

    // A socket kept alive across a 30s idle is dead by the time the next poll
    // reuses it, and undici surfaces that as `TypeError: fetch failed` rather
    // than retrying. The failed attempt evicts it, so the immediate second try
    // opens a fresh connection and succeeds — without this the watch polls
    // forever and never sees another message.
    let { data, error } = await poll();
    if (error) ({ data, error } = await poll());

    // One failed poll must not end the watch. A run of them must: a watcher
    // that logs and keeps looping is indistinguishable from a quiet thread,
    // which is the hold-with-no-watcher failure this script exists to prevent.
    if (error) {
      console.log(`poll failed: ${error.message}`);
      if (++failures >= MAX_FAILURES)
        throw new Error(`${failures} polls failed in a row, last: ${error.message}`);
    } else {
      failures = 0;
    }

    for (const m of data ?? []) {
      cursor = m.created_at ?? cursor;
      const text = String(m.content ?? "").replace(/\s+/g, " ").trim();
      const body = m.message_type === "image" ? `[image] ${text}` : text;
      console.log(`${(m.created_at ?? "").slice(11, 19)} ${who}: ${body.slice(0, 300)}`);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.log(`watcher died: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
