/**
 * Watches Carolin's thread for the bank details owed for the Rp 87.000 refund
 * (task 425a0151). One stdout line per new inbound message; a macOS banner the
 * moment one looks like an account number.
 *
 *   pnpm tsx --env-file=.env.local scripts/watch-carolin.ts
 */
import { execFile } from "node:child_process";
import { createAdminClient } from "../src/lib/supabase/admin";

const CUSTOMER_ID = "1a218c79-a19d-4167-b8b3-480b4cf08db6";
const POLL_MS = 45_000;
// A bank name, the word for an account, or a bare run of 8+ digits. Deliberately
// loose: a false positive costs one banner, a miss costs her waiting again.
const BANK =
  /\b(bca|mandiri|bni|bri|cimb|permata|danamon|ocbc|panin|jago|seabank|jenius|blu|neo|dana|gopay|ovo|shopeepay)\b|rekening|no\.?\s?rek|norek|a\.?n\.?\s|\d{8,}/i;

function notify(text: string) {
  const script = `display notification ${JSON.stringify(text)} with title "Claude Code — Carolin" sound name "Ping"`;
  execFile("osascript", ["-e", script], () => {});
}

async function main() {
  const db = createAdminClient();
  let cursor = new Date().toISOString();
  let notified = false;
  let lastInbound = Date.now();
  let nudged = false;

  for (;;) {
    const { data, error } = await db
      .from("conversations")
      .select("created_at, content")
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
        lastInbound = Date.now();
        const text = String(m.content ?? "").replace(/\s+/g, " ").trim();
        console.log(`Carolin: ${text.slice(0, 300)}`);
        if (!notified && BANK.test(text)) {
          notified = true;
          notify(`Bank details: ${text.slice(0, 180)}`);
          console.log("BANK DETAILS — transfer Rp 87.000 (task 425a0151)");
        }
      }
    }

    // She may simply not answer. The 24-hour window is what makes that
    // expensive, so say so long before it shuts rather than after.
    const quietHours = (Date.now() - lastInbound) / 3_600_000;
    if (!notified && !nudged && quietHours >= 4) {
      nudged = true;
      console.log(
        `NO REPLY ${quietHours.toFixed(1)}h — window shuts ~${(20 - quietHours).toFixed(1)}h from now`,
      );
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.log(`watcher died: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
