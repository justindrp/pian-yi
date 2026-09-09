/**
 * Watches Vania's thread (The Brooklyn SOHO, +6281292339008) while it is off
 * the bot for the Julian mix-up on 8 September.
 *
 * scripts/takeover-vania.ts holds her thread with no auto-resume, which means
 * nothing else will ever tell anyone she wrote. That is the Sherine Fayola
 * failure — a silenced thread nobody is watching — so this watcher is not
 * optional while the takeover stands: one macOS banner and one stdout line the
 * moment she says anything.
 *
 *   pnpm tsx --env-file=.env.local scripts/watch-vania.ts
 */
import { execFile } from "node:child_process";
import { createAdminClient } from "../src/lib/supabase/admin";

const CUSTOMER_ID = "2ca04f0d-d448-4b79-aa5e-7c5140ee6dd6";
const POLL_MS = 45_000;

function notify(text: string) {
  const script = `display notification ${JSON.stringify(text)} with title "Claude Code — Vania" sound name "Ping"`;
  execFile("osascript", ["-e", script], () => {});
}

async function main() {
  const db = createAdminClient();
  let cursor = new Date().toISOString();

  console.log("watching Vania — bot is held, every inbound needs a human");
  for (;;) {
    const { data, error } = await db
      .from("conversations")
      .select("created_at, content, message_type")
      .eq("customer_id", CUSTOMER_ID)
      .eq("role", "user")
      .gt("created_at", cursor)
      .order("created_at");

    if (error) {
      // One failed poll must not end the watch.
      console.log(`poll failed: ${error.message}`);
    } else {
      for (const m of data ?? []) {
        cursor = m.created_at ?? cursor;
        const text = String(m.content ?? "").replace(/\s+/g, " ").trim();
        console.log(`${(m.created_at ?? "").slice(11, 19)} Vania: ${text.slice(0, 300)}`);
        // Every message matters here: her window reopening is the only chance
        // to ask about Tuesday, and the bot will not answer her.
        notify(text.slice(0, 180) || "(image)");
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.log(`watcher died: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
