/**
 * Repoint the delivery rows sitting on the June-2026 import catch-all orders.
 *
 * The import created one `package_size = 0, total_price = 0` order per customer
 * and hung every historic delivery off it, leaving their real paid orders
 * holding no rows at all. Nothing can accrue off a row whose order has no
 * `price_per_portion` — `accrueDeliveryDate` skips it — so the revenue for food
 * that was bought and paid for is stranded in 2100.
 *
 * This is the same fix applied to Sky/Fidela/Rani on 2026-08-28: move the rows,
 * do not invent a price on the catch-all. Allocation follows `pickDrawOrder()`
 * — oldest order with unbooked quota first, overflow onto the newest active one
 * — because that is what every other draw path does and a different rule here
 * would reprice the same portions two ways.
 *
 * Kitchen matching is a *preference*, not a requirement (see "Which order a
 * delivery draws from" in CLAUDE.md): 70 customers hold quota only on a kitchen
 * they have left, and Ahmad Akbar is one of them — he bought three packages on
 * Perut Bahagia and ate from four other kitchens. Refusing to place those rows
 * would leave them stranded forever. Revenue still comes from the order he
 * actually paid, and COGS still comes from the kitchen that actually cooked, so
 * the journals are right either way.
 *
 * Run: pnpm tsx --env-file=.env.local scripts/repoint-catchall-rows.ts [--apply]
 */
import { logEdit } from "@/lib/audit/log-edit";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

const CATCH_ALL_PREFIXES = ["e24425a0", "b1f1de66"];
const DEAD = new Set([
  "cancelled_by_admin",
  "cancelled_by_customer",
  "cancelled",
  "expired",
]);
const ACTOR = "script:repoint-catchall-rows";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { rows: deliveries, error: dErr } = await fetchAllRows<{
    id: string;
    delivery_date: string;
    meal_type: string;
    portions: number | null;
    order_id: string | null;
    customer_id: string | null;
    subcontractor_id: string | null;
  }>((from, to) =>
    db
      .from("daily_deliveries")
      .select(
        "id, delivery_date, meal_type, portions, order_id, customer_id, subcontractor_id",
      )
      .order("delivery_date")
      .range(from, to),
  );
  const { rows: orders, error: oErr } = await fetchAllRows<{
    id: string;
    customer_id: string | null;
    status: string;
    package_size: number | null;
    price_per_portion: number | null;
    subcontractor_id: string | null;
    created_at: string | null;
  }>((from, to) =>
    db
      .from("orders")
      .select(
        "id, customer_id, status, package_size, price_per_portion, subcontractor_id, created_at",
      )
      .range(from, to),
  );
  const { rows: customers, error: cErr } = await fetchAllRows<{
    id: string;
    name: string | null;
  }>((from, to) => db.from("customers").select("id, name").range(from, to));
  if (dErr || oErr || cErr) {
    console.error("read failed:", dErr ?? oErr ?? cErr);
    process.exit(1);
  }

  const nameOf = new Map(customers.map((c) => [c.id, c.name ?? "?"]));
  const catchAlls = orders.filter((o) =>
    CATCH_ALL_PREFIXES.includes(o.id.slice(0, 8)),
  );

  let moved = 0;
  for (const catchAll of catchAlls) {
    const who = nameOf.get(catchAll.customer_id ?? "") ?? "?";
    const mine = deliveries
      .filter((r) => r.order_id === catchAll.id)
      .sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));
    if (!mine.length) {
      console.log(`\n=== ${who}: nothing left on ${catchAll.id.slice(0, 8)}`);
      continue;
    }

    // Targets: every other non-cancelled order with a package size, oldest
    // first. Deliberately NOT filtered to priced orders — `pickDrawOrder()`
    // does not filter on price either, and a zero-price order is usually real
    // quota. Hanna holds three, and `edit_log` names each one: a `grant_free_
    // quota` action for "compensation for late delivery", "reactivation promo"
    // and "Tidak konfirmasi ulang". They are absent from the `package_orders`
    // sheet because a grant was never a purchase, not because they are junk —
    // check `edit_log` before writing one off. Skipping them would invent an
    // over-draw of 4 porsi she does not have.
    const targets = orders
      .filter(
        (o) =>
          o.customer_id === catchAll.customer_id &&
          o.id !== catchAll.id &&
          (o.package_size ?? 0) > 0 &&
          !DEAD.has(o.status),
      )
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    if (!targets.length) {
      console.log(`\n=== ${who}: no other order to move onto — skipped`);
      continue;
    }

    // Quota already spent on each target by rows that are not ours to move.
    const used = new Map<string, number>();
    for (const t of targets) {
      used.set(
        t.id,
        deliveries
          .filter((r) => r.order_id === t.id)
          .reduce((s, r) => s + (r.portions ?? 0), 0),
      );
    }
    // Overflow lands on the newest *active* order, else the newest target —
    // an over-drawn customer still ate the food, and flooring the balance per
    // order would discard the over-draw instead of recording it.
    const overflow =
      [...targets].reverse().find((t) => t.status === "active") ??
      targets[targets.length - 1];

    console.log(
      `\n=== ${who}: ${mine.length} rows on catch-all ${catchAll.id.slice(0, 8)} ===`,
    );
    const plan: { row: (typeof mine)[number]; target: string; over: boolean }[] =
      [];
    for (const row of mine) {
      const portions = row.portions ?? 0;
      const fits = targets.find(
        (t) => (used.get(t.id) ?? 0) + portions <= (t.package_size ?? 0),
      );
      const target = fits ?? overflow;
      used.set(target.id, (used.get(target.id) ?? 0) + portions);
      plan.push({ row, target: target.id, over: !fits });
    }

    const byTarget = new Map<string, number>();
    for (const p of plan)
      byTarget.set(p.target, (byTarget.get(p.target) ?? 0) + 1);
    for (const t of targets) {
      const n = byTarget.get(t.id) ?? 0;
      if (!n) continue;
      const rate = t.price_per_portion
        ? `@Rp${t.price_per_portion.toLocaleString("id-ID")}`
        : "@Rp0 (grant — no revenue, COGS only)";
      console.log(
        `  -> ${t.id.slice(0, 8)} pkg ${t.package_size} ${rate} ${t.status}: ${n} rows`,
      );
    }
    const over = plan.filter((p) => p.over).length;
    if (over) {
      console.log(
        `  !! ${over} rows exceed every package and land on ${overflow.id.slice(0, 8)} (customer is over-drawn)`,
      );
    }

    if (!apply) continue;
    for (const p of plan) {
      const { error } = await db
        .from("daily_deliveries")
        .update({ order_id: p.target })
        .eq("id", p.row.id);
      if (error) {
        console.error(`  FAILED ${p.row.id}: ${error.message}`);
        continue;
      }
      await logEdit({
        db,
        actor: ACTOR,
        entityType: "daily_deliveries",
        entityId: p.row.id,
        action: "update",
        changes: {
          order_id: { from: catchAll.id, to: p.target },
          reason: "June import catch-all order had no price_per_portion",
          delivery_date: p.row.delivery_date,
          meal_type: p.row.meal_type,
          portions: p.row.portions,
        },
      });
      moved++;
    }
  }

  console.log(
    apply
      ? `\napplied: ${moved} rows repointed`
      : "\ndry run — pass --apply to write",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
