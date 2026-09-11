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
  console.log(`watching ${who} — every inbound needs a human`);

  for (;;) {
    const { data, error } = await db
      .from("conversations")
      .select("created_at, content, message_type")
      .eq("customer_id", cust.id)
      .eq("role", "user")
      .gt("created_at", cursor)
      .order("created_at");

    // One failed poll must not end the watch.
    if (error) console.log(`poll failed: ${error.message}`);

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
