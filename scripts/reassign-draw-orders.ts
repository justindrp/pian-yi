// Reassigns daily_deliveries rows that were charged to the wrong order of the
// same customer, and recomputes portions_remaining from what each order
// actually drew.
//
// Cause: every draw path picked a customer's order by taking the first row of
// an unordered `status = 'active'` query, so the oldest order kept collecting
// deliveries after it was full. Fixed in code by pickDrawOrder (commit
// 6bad2a7); this script cleans up what the old behaviour already wrote.
//
// Assignment rule: a delivery is re-pointed only when exactly one order's
// [start_date, end_date] window contains its date and that is not the order it
// currently points at. Anything else is reported, not touched.
//
// The rule started out cleverer — pack deliveries into whichever covering order
// still had capacity — and that was wrong. Many legacy imported orders have a
// null end_date, so their windows overlap for months and the "right" order is
// not recoverable from dates. On Jennifer Valerie it churned 147 rows just to
// shuffle a 7-portion deficit between two identical pkg-20 orders. Where the
// data cannot say which order a delivery belonged to, this script must not
// invent an answer.
//
// Balances are only recomputed for customers whose deliveries are all
// unambiguous. For the rest, the drawn total depends on assignments nobody can
// verify, so the counter is left alone and the customer is listed for a human.
//
// Dry run by default. Pass --apply to write.
//
//   pnpm tsx scripts/reassign-draw-orders.ts
//   pnpm tsx scripts/reassign-draw-orders.ts --apply

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

type Order = {
  id: string;
  customer_id: string | null;
  status: string;
  package_size: number | null;
  portions_remaining: number | null;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
};

type Delivery = {
  id: string;
  customer_id: string | null;
  order_id: string | null;
  delivery_date: string;
  meal_type: string;
  portions: number;
  status: string | null;
};

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase env vars missing");
  return createClient(url, key);
}

// Supabase caps a select at 1000 rows, and these tables are past that.
async function fetchAll<T>(
  table: string,
  columns: string,
): Promise<T[]> {
  const client = db();
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

function covers(order: Order, date: string): boolean {
  if (order.start_date && date < order.start_date) return false;
  if (order.end_date && date > order.end_date) return false;
  return true;
}

async function main() {
  const orders = await fetchAll<Order>(
    "orders",
    "id, customer_id, status, package_size, portions_remaining, start_date, end_date, created_at",
  );
  const deliveries = await fetchAll<Delivery>(
    "daily_deliveries",
    "id, customer_id, order_id, delivery_date, meal_type, portions, status",
  );

  const ordersByCustomer = new Map<string, Order[]>();
  for (const o of orders) {
    if (!o.customer_id) continue;
    const list = ordersByCustomer.get(o.customer_id) ?? [];
    list.push(o);
    ordersByCustomer.set(o.customer_id, list);
  }
  for (const list of ordersByCustomer.values()) {
    list.sort((a, b) =>
      (a.start_date ?? a.created_at) < (b.start_date ?? b.created_at) ? -1 : 1,
    );
  }

  const deliveriesByCustomer = new Map<string, Delivery[]>();
  for (const d of deliveries) {
    if (!d.customer_id) continue;
    if (d.status === "cancelled") continue;
    const list = deliveriesByCustomer.get(d.customer_id) ?? [];
    list.push(d);
    deliveriesByCustomer.set(d.customer_id, list);
  }

  const { data: customers } = await db()
    .from("customers")
    .select("id, name")
    .range(0, 4999);
  const nameOf = new Map((customers ?? []).map((c) => [c.id, c.name ?? c.id]));

  const moves: { id: string; from: string | null; to: string; label: string }[] = [];
  const balanceFixes: {
    id: string;
    label: string;
    was: number | null;
    now: number;
  }[] = [];
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  const skippedBalances: string[] = [];

  for (const [customerId, custOrders] of ordersByCustomer) {
    const custDeliveries = (deliveriesByCustomer.get(customerId) ?? []).sort(
      (a, b) =>
        a.delivery_date === b.delivery_date
          ? a.meal_type < b.meal_type
            ? -1
            : 1
          : a.delivery_date < b.delivery_date
            ? -1
            : 1,
    );
    if (custDeliveries.length === 0) continue;

    const drawn = new Map<string, number>(custOrders.map((o) => [o.id, 0]));
    let certain = true;

    for (const d of custDeliveries) {
      const covering = custOrders.filter((o) => covers(o, d.delivery_date));

      if (covering.length === 0) {
        certain = false;
        unresolved.push(
          `${nameOf.get(customerId)}  ${d.delivery_date} ${d.meal_type} x${d.portions}  (no order covers this date)`,
        );
        if (d.order_id) drawn.set(d.order_id, (drawn.get(d.order_id) ?? 0) + d.portions);
        continue;
      }

      if (covering.length > 1) {
        certain = false;
        ambiguous.push(
          `${nameOf.get(customerId)}  ${d.delivery_date} ${d.meal_type} x${d.portions}  (${covering.length} orders cover this date)`,
        );
        if (d.order_id) drawn.set(d.order_id, (drawn.get(d.order_id) ?? 0) + d.portions);
        continue;
      }

      const target = covering[0];
      drawn.set(target.id, (drawn.get(target.id) ?? 0) + d.portions);

      if (d.order_id !== target.id) {
        moves.push({
          id: d.id,
          from: d.order_id,
          to: target.id,
          label: `${nameOf.get(customerId)}  ${d.delivery_date} ${d.meal_type} x${d.portions}  ${d.order_id?.slice(0, 8) ?? "NULL"} → ${target.id.slice(0, 8)}`,
        });
      }
    }

    if (!certain) {
      skippedBalances.push(nameOf.get(customerId) ?? customerId);
      continue;
    }

    for (const o of custOrders) {
      const used = drawn.get(o.id) ?? 0;
      const shouldBe = (o.package_size ?? 0) - used;
      if (o.portions_remaining !== shouldBe) {
        balanceFixes.push({
          id: o.id,
          label: `${nameOf.get(customerId)}  order ${o.id.slice(0, 8)} pkg=${o.package_size} drew=${used}`,
          was: o.portions_remaining,
          now: shouldBe,
        });
      }
    }
  }

  console.log(`orders: ${orders.length}, deliveries: ${deliveries.length}`);
  console.log(`\n=== deliveries to re-point (${moves.length}) ===`);
  for (const m of moves) console.log(`  ${m.label}`);

  console.log(`\n=== portions_remaining to correct (${balanceFixes.length}) ===`);
  for (const b of balanceFixes) {
    console.log(`  ${b.label}: ${b.was} → ${b.now}`);
  }
  const wouldGoNegative = balanceFixes.filter((b) => b.now < 0);
  console.log(
    `  of which still negative after the fix (genuinely over-delivered): ${wouldGoNegative.length}`,
  );

  console.log(
    `\n=== left alone: date covered by more than one order (${ambiguous.length}) ===`,
  );
  for (const a of ambiguous) console.log(`  ${a}`);

  console.log(`\n=== left alone: no order covers the date (${unresolved.length}) ===`);
  for (const u of unresolved) console.log(`  ${u}`);

  console.log(
    `\n=== customers whose balances were NOT recomputed, needs a human (${skippedBalances.length}) ===`,
  );
  for (const s of skippedBalances) console.log(`  ${s}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to write.");
    return;
  }

  const client = db();
  let moved = 0;
  for (const m of moves) {
    const { error } = await client
      .from("daily_deliveries")
      .update({ order_id: m.to })
      .eq("id", m.id);
    if (error) {
      console.error(`  FAILED ${m.label}: ${error.message}`);
      continue;
    }
    moved++;
  }

  let fixed = 0;
  for (const b of balanceFixes) {
    const { error } = await client
      .from("orders")
      .update({ portions_remaining: b.now })
      .eq("id", b.id);
    if (error) {
      console.error(`  FAILED ${b.label}: ${error.message}`);
      continue;
    }
    fixed++;
  }

  console.log(`\nAPPLIED: ${moved} deliveries re-pointed, ${fixed} balances corrected.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
