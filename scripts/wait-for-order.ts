/**
 * Polls a customer's thread while the bot handles a live order, printing each
 * new message, and exits as soon as an order row appears (or the timeout hits)
 * so the watcher gets notified instead of re-reading the whole thread.
 *   tsx scripts/wait-for-order.ts +6287808781094 [minutes]
 */
import { createAdminClient } from "../src/lib/supabase/admin";

async function main() {
  const phone = process.argv[2];
  const minutes = Number(process.argv[3] ?? 30);
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
      console.log(`${(m.created_at ?? "").slice(11, 19)} [${m.role}] ${String(m.content).slice(0, 300).replace(/\n/g, " ")}`);
      lastSeen = m.created_at ?? lastSeen;
    }

    const { data: ords } = await db
      .from("orders")
      .select("id, status, package_size, total_price")
      .eq("customer_id", cust.id);
    if (ords && ords.length > 0) {
      console.log(`\n=== ORDER CREATED: ${ords.map((o) => `${o.id.slice(0, 8)} ${o.status} pkg=${o.package_size} Rp${o.total_price}`).join(" | ")}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 40_000));
  }
  console.log("\n=== timeout, still no order");
}
main().then(() => process.exit(0));
