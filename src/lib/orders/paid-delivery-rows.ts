import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeliveryDay } from "@/lib/holidays/id";
import { unbookedByOrder } from "@/lib/orders/customer-schedule";
import {
  type DrawCandidate,
  pickDrawOrder,
} from "@/lib/orders/pick-draw-order";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

export type RequestedSlot = {
  date: string;
  meal_type: string;
  portions: number;
};

export type PaidDeliveryRow = {
  delivery_date: string;
  customer_id: string | null;
  order_id: string;
  meal_type: string;
  portions: number;
  subcontractor_id: string | null;
  address_slot: number;
};

/**
 * Charge each delivery to the order that owes it, oldest package first.
 *
 * `mark_paid` used to stamp its own order id on every row it wrote, which is
 * right only when the schedule and the package are the same size. A top-up is
 * deliberately not: a customer holding 1 porsi who wants 7 days buys a 6-porsi
 * package, and the seventh delivery is the porsi the older order still owes
 * (see "A leftover porsi is spent before a new package is sold" in
 * `docs/BOT_RULES.md`). Veronica Catherine's 2026-08-30 order wrote all seven
 * against the new package: it sat 1 over its own size while the June order kept
 * a portion it had been paid for and could never complete. The row had to be
 * repointed by hand.
 *
 * FIFO is the same rule `pickDrawOrder()` applies everywhere else — the
 * portions bought first are the portions eaten first — so this reuses it rather
 * than restating it, one row at a time against a running balance.
 */
export function allocateDraws<T extends { portions: number }>(
  rows: readonly T[],
  candidates: readonly DrawCandidate[],
  fallbackOrderId: string,
): (T & { order_id: string })[] {
  const pool = candidates.map((c) => ({ ...c }));

  return rows.map((row) => {
    // Only orders with balance are offered. pickDrawOrder's own fallback picks
    // the newest order when none has any, which is the wrong answer here: the
    // order being paid is the package this schedule was sold as, so it takes
    // whatever the older ones cannot cover. Never null — a row we refuse to
    // charge is a meal that never reaches a kitchen.
    const pick = pickDrawOrder(pool.filter((c) => (c.unbooked ?? 0) > 0));
    if (!pick) return { ...row, order_id: fallbackOrderId };

    // A row is indivisible — `daily_deliveries` is unique on
    // (delivery_date, customer_id, meal_type) — so a 2-porsi row against 1
    // porsi of balance goes whole to that order and takes it 1 over. Splitting
    // it across two orders is not representable.
    pick.unbooked = (pick.unbooked ?? 0) - row.portions;
    return { ...row, order_id: pick.id };
  });
}

/**
 * The delivery rows an order's `requested_schedule` becomes when it is paid.
 *
 * Both `mark_paid` paths (`PATCH /api/orders`, the Assistant's
 * `mark_order_paid`) built these inline and identically; the FIFO charge above
 * is a rule neither should carry its own copy of.
 */
export async function buildPaidDeliveryRows(params: {
  db: Db;
  order: {
    id: string;
    customer_id: string | null;
    package_size: number | null;
    subcontractor_id: string | null;
    lunch_address_slot: number | null;
    dinner_address_slot: number | null;
  };
  customerSubcontractorId: string | null;
  requested: RequestedSlot[];
}): Promise<PaidDeliveryRow[]> {
  const { db, order, customerSubcontractorId, requested } = params;

  // Minggu and libur nasional are days nobody cooks. Dropping them leaves those
  // portions unbooked, which is right — the customer still owns them and can
  // move them. Sorted so the FIFO charge runs in delivery order rather than
  // whatever order the model listed the days in; lunch precedes dinner.
  const slots = requested
    .filter((r) => isDeliveryDay(r.date))
    .sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date
          ? -1
          : 1
        : (a.meal_type === "dinner" ? 1 : 0) -
          (b.meal_type === "dinner" ? 1 : 0),
    );
  if (slots.length === 0) return [];

  const { data: active } = order.customer_id
    ? await db
        .from("orders")
        .select("id, package_size, start_date, created_at")
        .eq("customer_id", order.customer_id)
        .eq("status", "active")
    : { data: null };

  const rows: {
    id: string;
    package_size: number | null;
    start_date: string | null;
    created_at: string | null;
  }[] = (active ?? []).map((o) => ({
    id: o.id,
    package_size: o.package_size,
    start_date: o.start_date,
    created_at: o.created_at,
  }));
  // Both callers flip the order to `active` before they get here, so it is
  // normally in that list already. If the read misses it, add it anyway: the
  // package this schedule was sold as must be a candidate for its own days, or
  // an older order takes rows it cannot pay for.
  if (!rows.some((o) => o.id === order.id)) {
    rows.push({
      id: order.id,
      package_size: order.package_size,
      start_date: null,
      created_at: new Date().toISOString(),
    });
  }
  const unbooked = await unbookedByOrder(db, rows);

  const candidates: DrawCandidate[] = rows.map((o) => ({
    id: o.id,
    unbooked: unbooked.get(o.id) ?? 0,
    start_date: o.start_date,
    created_at: o.created_at,
  }));

  const charged = allocateDraws(slots, candidates, order.id);

  return charged.map((r) => ({
    delivery_date: r.date,
    customer_id: order.customer_id,
    order_id: r.order_id,
    meal_type: r.meal_type,
    portions: r.portions,
    // The order's own kitchen is an override; the customer's is the default.
    // Without the fallback a delivery row carries a null subcontractor_id, and
    // /dapur/[id] filters strictly on it — so the kitchen never sees the
    // delivery. Julian S's whole renewal was invisible that way.
    subcontractor_id: order.subcontractor_id ?? customerSubcontractorId ?? null,
    address_slot:
      r.meal_type === "dinner"
        ? (order.dinner_address_slot ?? 1)
        : (order.lunch_address_slot ?? 1),
  }));
}
