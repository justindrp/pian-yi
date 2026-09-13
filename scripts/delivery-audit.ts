/**
 * Prints one kitchen's delivery sheet for a date next to each customer's recent
 * chat, so the two can be compared line by line. The recurring 16:00 job: the
 * order cutoff has just passed, tomorrow's sheet is final, and this is the last
 * moment a wrong row can be fixed before the kitchen cooks it.
 *
 *   pnpm sheet                          # tomorrow, Dapur Suplir
 *   pnpm sheet --date 2026-09-15
 *   pnpm sheet --kitchen monstera
 *   pnpm sheet --messages 40            # deeper transcript (default 25)
 *
 * It prints two sections. The rows on the sheet, each with the customer's
 * kitchen_notes, address slot and drawn order — and under each, their chat.
 * Then the customers of that kitchen who hold an active order and have written
 * to us in the last 48h but have NO row for the date: a skip that was asked for
 * and never applied looks exactly like a day they never booked, and only the
 * chat can tell them apart.
 *
 * Related: scripts/review-chats.ts is the same read for the inbox rather than
 * the sheet. This one is rooted in daily_deliveries.
 */
import { createAdminClient } from "../src/lib/supabase/admin";

type Db = ReturnType<typeof createAdminClient>;

function wib(iso: string): string {
  return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" });
}

function jakartaToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function author(m: {
  role: string | null;
  model_used: string | null;
  sent_by: string | null;
}): string {
  if (m.role === "user") return "CUSTOMER";
  return `US [${[m.model_used ?? "?", m.sent_by].filter(Boolean).join(" ")}]`;
}

async function printChat(db: Db, customerId: string, limit: number) {
  const { data: msgs } = await db
    .from("conversations")
    .select(
      "created_at, role, content, message_type, media_url, model_used, sent_by, whatsapp_status, whatsapp_error",
    )
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  for (const m of (msgs ?? []).reverse()) {
    const fail =
      m.whatsapp_status === "failed"
        ? ` FAILED ${JSON.stringify(m.whatsapp_error)}`
        : "";
    console.log(
      `    ${m.created_at ? wib(m.created_at) : "?"} ${author(m)}${fail} [${m.message_type}] ${m.content ?? ""}${m.media_url ? " (media)" : ""}`,
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) =>
    argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? "").trim() : "";

  const date = flag("--date") || addDays(jakartaToday(), 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("--date needs YYYY-MM-DD");
  const asked = flag("--kitchen") || "suplir";
  const messages = Number(flag("--messages") || 25);

  const db = createAdminClient();
  const { data: kitchens, error } = await db
    .from("subcontractors")
    .select("id, name, customer_nickname, delivery_days, is_active");
  if (error) throw new Error(error.message);
  const needle = asked.toLowerCase();
  const kitchen = (kitchens ?? []).find(
    (k) =>
      k.id === asked ||
      (k.customer_nickname ?? "").toLowerCase().includes(needle) ||
      k.name.toLowerCase().includes(needle),
  );
  if (!kitchen) throw new Error(`no kitchen matching "${asked}"`);

  // The row's own kitchen, not the order's: a package may be split across
  // kitchens, so filtering on orders.subcontractor_id would show the wrong day.
  const { data: rows } = await db
    .from("daily_deliveries")
    .select(
      "id, customer_id, order_id, meal_type, portions, address_slot, notes, price_per_portion, customers(name, phone_number, area, sub_area, kitchen_notes, delivery_route), orders(size, package_size, price_per_portion)",
    )
    .eq("delivery_date", date)
    .eq("subcontractor_id", kitchen.id)
    .order("meal_type");

  const list = rows ?? [];
  const portions = list.reduce((n, r) => n + (r.portions ?? 0), 0);
  console.log(
    `${kitchen.customer_nickname ?? kitchen.name} — ${date} — ${list.length} row(s), ${portions} portion(s)`,
  );
  console.log("=".repeat(78));

  for (const r of list) {
    const c = r.customers as unknown as Record<string, string | null> | null;
    const o = r.orders as unknown as Record<string, unknown> | null;
    console.log(
      `${c?.name ?? "(no name)"}  ${c?.phone_number ?? "?"}  ${c?.area ?? "-"}${c?.sub_area ? ` / ${c.sub_area}` : ""}`,
    );
    console.log(
      `  ${r.meal_type} ${r.portions}p  size ${String(o?.size ?? "-")}  alamat ${r.address_slot ?? 1}  rute ${c?.delivery_route ?? "-"}  order ${String(r.order_id).slice(0, 8)}`,
    );
    if (r.notes) console.log(`  notes: ${r.notes}`);
    if (c?.kitchen_notes) console.log(`  kitchen_notes: ${c.kitchen_notes}`);
    await printChat(db, r.customer_id as string, messages);
    console.log("-".repeat(78));
  }

  // A skip asked for and never applied is invisible on the sheet — it looks
  // like a day the customer never booked. Only the chat separates the two.
  const onSheet = new Set(list.map((r) => r.customer_id as string));
  const since = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const { data: recent } = await db
    .from("conversations")
    .select("customer_id")
    .eq("role", "user")
    .gte("created_at", since);
  const wrote = [
    ...new Set((recent ?? []).map((m) => m.customer_id as string)),
  ].filter((id) => !onSheet.has(id));
  if (wrote.length === 0) return;

  const { data: theirs } = await db
    .from("orders")
    .select("customer_id, id, status, subcontractor_id")
    .in("customer_id", wrote)
    .eq("status", "active")
    .eq("subcontractor_id", kitchen.id);
  const quiet = [
    ...new Set((theirs ?? []).map((o) => o.customer_id as string)),
  ];
  if (quiet.length === 0) return;

  console.log();
  console.log(
    `${quiet.length} customer(s) on this kitchen wrote to us in the last 48h and have NO row on ${date}`,
  );
  console.log("=".repeat(78));
  for (const id of quiet) {
    const { data: c } = await db
      .from("customers")
      .select("name, phone_number, area, kitchen_notes")
      .eq("id", id)
      .single();
    console.log(
      `${c?.name ?? "(no name)"}  ${c?.phone_number ?? "?"}  ${c?.area ?? "-"}`,
    );
    if (c?.kitchen_notes) console.log(`  kitchen_notes: ${c.kitchen_notes}`);
    await printChat(db, id, messages);
    console.log("-".repeat(78));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
