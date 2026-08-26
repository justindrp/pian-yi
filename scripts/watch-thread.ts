/**
 * Prints a customer's recent thread, orders and deliveries by phone number.
 * Used to babysit a live conversation while the bot handles it.
 *   tsx scripts/watch-thread.ts +6287808781094 [n]
 */
import { createAdminClient } from "../src/lib/supabase/admin";

async function main() {
  const phone = process.argv[2];
  const n = Number(process.argv[3] ?? 14);
  const db = createAdminClient();

  const { data: cust } = await db
    .from("customers")
    .select(
      "id, name, phone_number, area, address, subcontractor_id, created_at",
    )
    .eq("phone_number", phone)
    .maybeSingle();
  if (!cust) return console.log(`no customer row for ${phone}`);
  console.log(JSON.stringify(cust, null, 1));

  const { data: flags } = await db
    .from("customer_flags")
    .select("escalated_to_human, pending_bot_response, pending_bot_question")
    .eq("customer_id", cust.id)
    .maybeSingle();
  console.log("flags:", JSON.stringify(flags));

  const { data: msgs } = await db
    .from("conversations")
    .select("created_at, role, content, message_type, whatsapp_status")
    .eq("customer_id", cust.id)
    .order("created_at", { ascending: false })
    .limit(n);
  console.log("\n--- thread ---");
  for (const m of (msgs ?? []).reverse())
    console.log(
      `${(m.created_at ?? "").slice(11, 19)} [${m.role}${m.whatsapp_status ? `/${m.whatsapp_status}` : ""}] ${String(m.content).slice(0, 260).replace(/\n/g, " ")}`,
    );

  const { data: ords } = await db
    .from("orders")
    .select(
      "id, status, package_size, portions_remaining, meal_time_preference, total_price, created_at",
    )
    .eq("customer_id", cust.id)
    .order("created_at", { ascending: false });
  console.log("\n--- orders ---");
  for (const o of ords ?? [])
    console.log(
      `${o.id.slice(0, 8)} ${o.status} pkg=${o.package_size} rem=${o.portions_remaining} ${o.meal_time_preference} Rp${o.total_price} ${(o.created_at ?? "").slice(0, 16)}`,
    );

  const { data: dels } = await db
    .from("daily_deliveries")
    .select("delivery_date, meal_type, portions, status")
    .eq("customer_id", cust.id)
    .order("delivery_date", { ascending: false })
    .limit(12);
  console.log("\n--- deliveries ---");
  for (const d of dels ?? [])
    console.log(`${d.delivery_date} ${d.meal_type} ${d.portions}p ${d.status}`);
}
main().then(() => process.exit(0));
