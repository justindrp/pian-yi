// Reassigns daily_deliveries rows that were charged to the wrong order of the
// same customer, and recomputes portions_remaining from what each order
// actually drew.
//
// Cause: every draw path picked a customer's order by taking the first row of
// an unordered `status = 'active'` query, so the oldest order kept collecting
// deliveries after it was full. Fixed in code by pickDrawOrder (commit
// 6bad2a7); this script cleans up what the old behaviour already wrote.
//
// Assignment rule: FIFO. Per customer, walk the deliveries oldest-first and
// fill the packages in the order they were bought — the first 20 deliveries go
// to a 20-portion package, the next 40 to the 40-portion package bought after
// it, and so on.
//
// This is what a prepaid quota means: portions bought first are used first. An
// order has no end date because it does not end on a date, it ends when its
// portions run out, so capacity — not the calendar — is the boundary between
// one package and the next. An earlier version of this script tried to match
// deliveries to orders by date window, which could not attribute anything for a
// customer holding several open-ended packages (Jennifer Valerie: 5 packages,
// 167 deliveries, nothing decidable) and left ~1274 rows untouched.
//
// Two guards on the fill:
//   - A delivery is never charged to a package that had not started yet on its
//     date. If the next package has not begun, the current one absorbs the
//     delivery and goes negative — that is a customer who drew ahead of buying,
//     and the negative is the honest record of it.
//   - A delivery is never split across two packages. If 1 portion of capacity
//     is left and a 2-portion delivery arrives, the whole delivery moves to the
//     next package and the leftover portion stays unused.
//
// Portions past the customer's total capacity land on their newest package,
// which is where an over-draw is visible today.
//
// Cancelled and skipped deliveries draw nothing and are ignored throughout.
//
// Dry run by default. --apply writes, and first dumps every value it is about
// to overwrite to scripts/rollback-<timestamp>.json, which --rollback replays.
//
//   pnpm tsx scripts/reassign-draw-orders.ts
//   pnpm tsx scripts/reassign-draw-orders.ts --apply
//   pnpm tsx scripts/reassign-draw-orders.ts --rollback scripts/rollback-….json

import { readFileSync, writeFileSync } from "node:fs";
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

// A package cannot be drawn from before it exists.
function hasStarted(order: Order, date: string): boolean {
  const from = order.start_date ?? order.created_at.slice(0, 10);
  return date >= from;
}

// Cancelled and refunded packages hold no quota to draw from.
const DEAD_STATUSES = new Set([
  "cancelled_unpaid",
  "cancelled_by_customer",
  "cancelled_by_admin",
  "refunded",
]);

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
    if (DEAD_STATUSES.has(o.status)) continue;
    const list = ordersByCustomer.get(o.customer_id) ?? [];
    list.push(o);
    ordersByCustomer.set(o.customer_id, list);
  }
  for (const list of ordersByCustomer.values()) {
    list.sort((a, b) =>
      (a.start_date ?? a.created_at) < (b.start_date ?? b.created_at) ? -1 : 1,
    );
  }

  const { data: customers } = await db()
    .from("customers")
    .select("id, name, linked_order_id")
    .range(0, 4999);
  const nameOf = new Map((customers ?? []).map((c) => [c.id, c.name ?? c.id]));

  // A customer with linked_order_id draws from someone else's package — the
  // split-payer case, e.g. Darren Dior eats off his sister Daryn's order. Their
  // deliveries belong in the owner's FIFO run, not their own: they share one
  // balance, so filling them separately would let the same portions be counted
  // twice. Group by quota owner, not by who ate.
  const quotaOwner = new Map<string, string>();
  const ownerOfOrder = new Map(orders.map((o) => [o.id, o.customer_id]));
  for (const c of customers ?? []) {
    if (!c.linked_order_id) continue;
    const owner = ownerOfOrder.get(c.linked_order_id);
    if (owner && owner !== c.id) quotaOwner.set(c.id, owner);
  }

  const deliveriesByCustomer = new Map<string, Delivery[]>();
  for (const d of deliveries) {
    if (!d.customer_id) continue;
    if (d.status === "cancelled" || d.status === "skipped") continue;
    const key = quotaOwner.get(d.customer_id) ?? d.customer_id;
    const list = deliveriesByCustomer.get(key) ?? [];
    list.push(d);
    deliveriesByCustomer.set(key, list);
  }

  const moves: { id: string; from: string | null; to: string; label: string }[] = [];
  const balanceFixes: {
    id: string;
    label: string;
    was: number | null;
    now: number;
  }[] = [];
  const drewAhead: string[] = [];
  const overCapacity: string[] = [];
  const zeroPackage: string[] = [];
  const noRealPackage: string[] = [];

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

    const name = nameOf.get(customerId) ?? customerId;

    // A pkg=0 row is not a package with no capacity — it is not a package at
    // all. All 88 of them carry total_price=0 and have no row in the verified
    // package_orders sheet, and for 76 of the 77 customers holding one, the
    // customer's real orders already account for every sheet row. They are
    // import artifacts.
    //
    // The first version of this script skipped any customer holding one, on the
    // theory that a zero-capacity package would make FIFO dump its deliveries
    // onto a neighbour. That reasoning was backwards: the neighbour is the real
    // package, and moving the draws there is the correction, not the damage.
    const realOrders = custOrders.filter((o) => (o.package_size ?? 0) > 0);
    for (const o of custOrders) {
      if ((o.package_size ?? 0) === 0) {
        zeroPackage.push(`${name}  order ${o.id.slice(0, 8)} ${o.status} pkg=0`);
      }
    }
    // Nothing to fill: every order this customer has is an artifact, so their
    // deliveries have no real package to draw from. Leave them alone and report.
    if (realOrders.length === 0) {
      noRealPackage.push(`${name}  ${custDeliveries.length} deliveries, no real package`);
      continue;
    }

    const drawn = new Map<string, number>(realOrders.map((o) => [o.id, 0]));

    // Index of the package currently being filled. It only ever moves forward:
    // once a package is full its remaining capacity is spent, and a later
    // delivery never goes back to it.
    let cursor = 0;

    for (const d of custDeliveries) {
      // Advance past packages that are full, or that cannot take this delivery
      // whole. Never advance onto a package that had not started on this date.
      while (cursor < realOrders.length - 1) {
        const cur = realOrders[cursor];
        const room = (cur.package_size ?? 0) - (drawn.get(cur.id) ?? 0);
        if (room >= d.portions) break;
        if (!hasStarted(realOrders[cursor + 1], d.delivery_date)) break;
        cursor++;
      }

      const target = realOrders[cursor];
      const room = (target.package_size ?? 0) - (drawn.get(target.id) ?? 0);

      // Borrowed rows are filed under the quota owner, so name whoever actually
      // ate — otherwise Darren's deliveries read as Daryn's in the report.
      const who =
        d.customer_id && d.customer_id !== customerId
          ? `${nameOf.get(d.customer_id) ?? d.customer_id} (via ${name})`
          : name;

      if (room < d.portions) {
        // Nowhere left to put it: either the customer drew before their next
        // package started, or they are past everything they ever bought. Either
        // way it lands here and the balance goes negative, which is the true
        // record of an over-draw.
        const isLast = cursor === realOrders.length - 1;
        (isLast ? overCapacity : drewAhead).push(
          `${who}  ${d.delivery_date} ${d.meal_type} x${d.portions}  → ${target.id.slice(0, 8)} (room ${room})`,
        );
      }

      drawn.set(target.id, (drawn.get(target.id) ?? 0) + d.portions);

      if (d.order_id !== target.id) {
        moves.push({
          id: d.id,
          from: d.order_id,
          to: target.id,
          label: `${who}  ${d.delivery_date} ${d.meal_type} x${d.portions}  ${d.order_id?.slice(0, 8) ?? "NULL"} → ${target.id.slice(0, 8)}`,
        });
      }
    }

    for (const o of realOrders) {
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
    `\n=== drew before the next package started (${drewAhead.length}) ===`,
  );
  for (const a of drewAhead) console.log(`  ${a}`);

  console.log(
    `\n=== delivered past everything the customer ever bought (${overCapacity.length}) ===`,
  );
  for (const o of overCapacity) console.log(`  ${o}`);

  console.log(
    `\n=== import artifacts, pkg=0 — ignored as draw targets, delete separately (${zeroPackage.length}) ===`,
  );
  for (const z of zeroPackage) console.log(`  ${z}`);

  console.log(
    `\n=== customers whose ONLY orders are artifacts — left untouched (${noRealPackage.length}) ===`,
  );
  for (const n of noRealPackage) console.log(`  ${n}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to write.");
    return;
  }

  // The writes are ~890 separate statements over PostgREST, not one
  // transaction, so a crash partway leaves the data half-changed. The whole
  // undo plan is written to disk first, complete, before a single row is
  // touched — a file written afterwards would be missing exactly the rows that
  // a crash had already changed.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rollbackPath = `scripts/rollback-${stamp}.json`;
  const plan: RollbackPlan = {
    created_at: new Date().toISOString(),
    deliveries: moves.map((m) => ({ id: m.id, before: m.from, after: m.to })),
    orders: balanceFixes.map((b) => ({ id: b.id, before: b.was, after: b.now })),
  };
  writeFileSync(rollbackPath, JSON.stringify(plan, null, 2));
  console.log(`\nrollback plan written: ${rollbackPath}`);

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
  console.log(`Undo with: pnpm tsx scripts/reassign-draw-orders.ts --rollback ${rollbackPath}`);
}

type RollbackPlan = {
  created_at: string;
  deliveries: { id: string; before: string | null; after: string }[];
  orders: { id: string; before: number | null; after: number }[];
};

// Puts back what the apply changed.
//
// A row is only restored when it still holds the value this script wrote. If
// something else has touched it since — an admin saving a daily sheet, the
// nightly quota cron — the newer value is left alone and reported, because
// undoing this script must not also undo somebody else's work.
async function rollback(path: string): Promise<void> {
  const plan = JSON.parse(readFileSync(path, "utf8")) as RollbackPlan;
  console.log(
    `rolling back ${path} (applied ${plan.created_at}): ${plan.deliveries.length} deliveries, ${plan.orders.length} orders`,
  );

  const client = db();
  let restored = 0;
  let changedSince = 0;

  for (const d of plan.deliveries) {
    const { data } = await client
      .from("daily_deliveries")
      .select("order_id")
      .eq("id", d.id)
      .maybeSingle();
    if (!data) continue;
    if (data.order_id !== d.after) {
      changedSince++;
      console.log(
        `  skipped delivery ${d.id.slice(0, 8)}: now ${data.order_id?.slice(0, 8) ?? "NULL"}, not the ${d.after.slice(0, 8)} this script set`,
      );
      continue;
    }
    const { error } = await client
      .from("daily_deliveries")
      .update({ order_id: d.before })
      .eq("id", d.id);
    if (error) {
      console.error(`  FAILED delivery ${d.id}: ${error.message}`);
      continue;
    }
    restored++;
  }

  for (const o of plan.orders) {
    const { data } = await client
      .from("orders")
      .select("portions_remaining")
      .eq("id", o.id)
      .maybeSingle();
    if (!data) continue;
    if (data.portions_remaining !== o.after) {
      changedSince++;
      console.log(
        `  skipped order ${o.id.slice(0, 8)}: now ${data.portions_remaining}, not the ${o.after} this script set`,
      );
      continue;
    }
    const { error } = await client
      .from("orders")
      .update({ portions_remaining: o.before })
      .eq("id", o.id);
    if (error) {
      console.error(`  FAILED order ${o.id}: ${error.message}`);
      continue;
    }
    restored++;
  }

  console.log(
    `\nROLLED BACK: ${restored} rows restored, ${changedSince} left alone because something else changed them since.`,
  );
}

const rollbackFlag = process.argv.indexOf("--rollback");
const entry =
  rollbackFlag !== -1
    ? (() => {
        const path = process.argv[rollbackFlag + 1];
        if (!path) throw new Error("--rollback needs a path to a rollback JSON file");
        return rollback(path);
      })()
    : main();

entry.catch((err) => {
  console.error(err);
  process.exit(1);
});
