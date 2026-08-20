/**
 * Reopens orders that were completed while still owing food.
 *
 * The `deduct-daily-quota` cron used to complete an order when its stored
 * `portions_remaining` hit 0. That counter reaches 0 when the calendar fills,
 * not when the food goes out, so a fully-*booked* order was closed with every
 * one of its meals still to come. Nadya's closed on 2026-08-13 holding twelve
 * undelivered meals, which left her with no active order at all and the bot
 * with no quota context for her. The cron now completes on
 * `orderRemainingToday()`; this repairs the ones it already closed.
 *
 * Reopening is only safe because the sheet generators now skip orders with no
 * unbooked quota (`unbookedByOrder`). Without that guard an order back on
 * `active` with a standing meal_time_preference generates a fresh row on every
 * Generate, indefinitely, past its package.
 *
 *   tsx --env-file=.env.local scripts/reopen-underdelivered-orders.ts
 *   tsx --env-file=.env.local scripts/reopen-underdelivered-orders.ts --apply
 */
import { createClient } from "@supabase/supabase-js";
import { fetchAllRows } from "../src/lib/supabase/fetch-all";
import { jakartaDateString } from "../src/lib/menu/week";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

const APPLY = process.argv.includes("--apply");
const TODAY = jakartaDateString();

type Order = {
  id: string;
  customer_id: string | null;
  status: string | null;
  package_size: number | null;
  completed_at: string | null;
  meal_time_preference: string | null;
  // Supabase's generated types call an embed an array; the explicit FK hint
  // returns a single object at runtime. Accept both and read it through
  // custName() rather than guessing wrong in one direction.
  customers: { name: string | null } | { name: string | null }[] | null;
};

function custName(o: Order): string {
  const c = Array.isArray(o.customers) ? o.customers[0] : o.customers;
  return c?.name ?? "?";
}

async function main() {
  const { rows: orders, error: e1 } = await fetchAllRows<Order>((from, to) =>
    db
      .from("orders")
      .select(
        "id, customer_id, status, package_size, completed_at, meal_time_preference, customers!orders_customer_id_fkey(name)",
      )
      .eq("status", "completed")
      .range(from, to),
  );
  const { rows: dels, error: e2 } = await fetchAllRows<{
    order_id: string | null;
    portions: number | null;
    status: string | null;
    delivery_date: string;
  }>((from, to) =>
    db
      .from("daily_deliveries")
      .select("order_id, portions, status, delivery_date")
      .range(from, to),
  );
  if (e1 || e2) throw new Error(`${e1 ?? ""} ${e2 ?? ""}`.trim());

  // drawnToDate = delivered, not merely dated. booked = everything on the
  // calendar, which is what decides whether reopening generates new rows.
  const drawn = new Map<string, number>();
  const booked = new Map<string, number>();
  for (const d of dels) {
    if (!d.order_id || d.status === "cancelled" || d.status === "skipped") continue;
    booked.set(d.order_id, (booked.get(d.order_id) ?? 0) + (d.portions ?? 0));
    if (d.delivery_date <= TODAY)
      drawn.set(d.order_id, (drawn.get(d.order_id) ?? 0) + (d.portions ?? 0));
  }

  // Only orders this cron actually closed. An order completed by some older
  // path carries no completed_at, and reopening those is a separate decision
  // with no incident behind it.
  const targets = orders.filter((o) => {
    if (!o.completed_at) return false;
    const b = booked.get(o.id) ?? 0;
    if (b === 0) return false;
    return (o.package_size ?? 0) - (drawn.get(o.id) ?? 0) > 0;
  });

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — today ${TODAY}`);
  console.log(`completed orders still owing food: ${targets.length}\n`);

  for (const o of targets) {
    const b = booked.get(o.id) ?? 0;
    const owed = (o.package_size ?? 0) - (drawn.get(o.id) ?? 0);
    const unbooked = (o.package_size ?? 0) - b;
    console.log(
      `${custName(o).padEnd(16)} ${o.id.slice(0, 8)} pkg=${o.package_size} owed=${owed} unbooked=${unbooked} pref=${o.meal_time_preference} closed=${o.completed_at?.slice(0, 10)}`,
    );
    if (unbooked > 0)
      console.log(`      will generate up to ${unbooked} more row(s) — expected, that quota is unbooked`);

    if (APPLY) {
      const { error } = await db
        .from("orders")
        .update({ status: "active", completed_at: null })
        .eq("id", o.id)
        .eq("status", "completed");
      console.log(error ? `      FAILED: ${error.message}` : "      reopened");
    }
  }

  if (!APPLY && targets.length > 0) console.log("\nre-run with --apply to reopen these.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
