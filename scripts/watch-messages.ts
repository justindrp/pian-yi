/**
 * Prints a customer's new messages as they arrive, until the timeout — the
 * message-only half of wait-for-order.ts, for a thread whose order already
 * exists but that a human is still driving.
 *   tsx scripts/watch-messages.ts +62... [minutes]
 */
import { createAdminClient } from "../src/lib/supabase/admin";

async function main() {
  const phone = process.argv[2];
  const minutes = Number(process.argv[3] ?? 20);
  const db = createAdminClient();
  const deadline = Date.now() + minutes * 60_000;

  const { data: cust } = await db
    .from("customers")
    .select("id")
    .eq("phone_number", phone)
    .maybeSingle();
  if (!cust) return console.log(`no customer row for ${phone}`);

  let lastSeen = new Date().toISOString();
  while (Date.now() < deadline) {
    const { data: msgs } = await db
      .from("conversations")
      .select("created_at, role, content")
      .eq("customer_id", cust.id)
      .gt("created_at", lastSeen)
      .order("created_at", { ascending: true });
    for (const m of msgs ?? []) {
      console.log(
        `${(m.created_at ?? "").slice(11, 19)} [${m.role}] ${String(m.content).slice(0, 300).replace(/\n/g, " ")}`,
      );
      lastSeen = m.created_at ?? lastSeen;
    }
    await new Promise((r) => setTimeout(r, 40_000));
  }
  console.log("=== watch ended");
}
main().then(() => process.exit(0));
