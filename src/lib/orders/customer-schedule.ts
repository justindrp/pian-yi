import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deliveryWindow,
  loadKitchenWindows,
} from "@/lib/deliveries/windows";
import { jakartaDateString } from "@/lib/menu/week";
import { PAID_STATUSES } from "@/lib/orders/paid-statuses";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/**
 * The two numbers people mean by "sisa kuota", and the dates behind them.
 *
 * `remainingToday` — bought but not yet delivered. What a customer is asking
 * for when they ask how much they have left.
 * `unbooked` — bought and not yet on the calendar. How many more dates they can
 * still ask for.
 *
 * Nadya's were 12 and 0 on 2026-08-20: twelve meals still coming, every one of
 * them already dated. `orders.portions_remaining` cached the second number and
 * was read as the first, which is how a fully-paid customer gets told her
 * package is finished. Both are counted from the rows now; the column is gone.
 */
export type CustomerSchedule = {
  /**
   * `window` is the arrival window of the kitchen that cooks that row, as the
   * customer reads it ("11.30-12.30"). It is per kitchen, so it cannot be
   * derived from `mealType` where the prompt prints it — Thenie's lunch ends
   * at 12.30 and the default says 12.00.
   */
  upcoming: {
    date: string;
    mealType: string;
    portions: number;
    window: string;
    /** 1 = the customer's main address, 2 = their second one. */
    addressSlot: number;
  }[];
  remainingToday: number;
  unbooked: number;
  /**
   * Portions bought across every paid order. Summed here rather than read off
   * one order, because the other two numbers are customer-wide and a CONTEXT
   * block whose halves count different sets is what the claim checker rejects
   * by construction — see `activeOrder` in validate-reply.ts.
   */
  packageSize: number;
  /**
   * The addresses this customer has on file, by slot — one entry, or two.
   *
   * Without them the model cannot say where a delivery is going, and it will
   * not leave that blank: asked on 2026-09-06 to send Tuesday's lunch to her
   * kost, Cindi was told "jadwal di catatan kami memang sudah begitu kok" for a
   * row that was pointed at UPH Gate 2. It is also what picks the `address_slot`
   * for `change_delivery_address`.
   */
  addresses: { slot: number; label: string }[];
};

/** Short enough for a prompt line, long enough to tell two addresses apart. */
function addressLabel(address: string | null, area: string | null): string {
  const text =
    (address ?? "").trim() || (area ?? "").trim() || "alamat tercatat";
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}


/** Null when the customer has never bought a package. */
export async function loadCustomerSchedule(
  db: Db,
  customerId: string,
  today: string = jakartaDateString(),
): Promise<CustomerSchedule | null> {
  const [{ data: orders }, { data: rows }, { data: customer }] =
    await Promise.all([
      db
        .from("orders")
        .select("package_size")
        .eq("customer_id", customerId)
        .in("status", PAID_STATUSES),
      db
        .from("daily_deliveries")
        .select(
          "delivery_date, meal_type, portions, subcontractor_id, address_slot",
        )
        .eq("customer_id", customerId)
        .order("delivery_date"),
      db
        .from("customers")
        .select("address, area, address_2, area_2")
        .eq("id", customerId)
        .maybeSingle(),
    ]);

  if (!orders?.length) return null;

  const bought = orders.reduce((s, o) => s + (o.package_size ?? 0), 0);
  // Counted customer-wide rather than per order, deliberately: which order a
  // delivery was charged to is unreliable (see pick-draw-order.ts), and the
  // customer only ever asks about their own total.
  const all = rows ?? [];
  const drawnToDate = all
    .filter((r) => (r.delivery_date ?? "") <= today)
    .reduce((s, r) => s + (r.portions ?? 0), 0);
  const drawnAll = all.reduce((s, r) => s + (r.portions ?? 0), 0);

  const upcoming = all.filter((r) => (r.delivery_date ?? "") >= today).slice(0, 12);
  const kitchens = await loadKitchenWindows(
    db,
    upcoming.map((r) => r.subcontractor_id),
  );

  return {
    remainingToday: bought - drawnToDate,
    unbooked: bought - drawnAll,
    packageSize: bought,
    upcoming: upcoming.map((r) => ({
      date: (r.delivery_date ?? "").slice(0, 10),
      mealType: r.meal_type ?? "lunch",
      portions: r.portions ?? 0,
      window: deliveryWindow(
        r.meal_type ?? "lunch",
        r.subcontractor_id ? kitchens.get(r.subcontractor_id) : null,
      ).label,
      addressSlot: r.address_slot ?? 1,
    })),
    addresses: [
      {
        slot: 1,
        label: addressLabel(customer?.address ?? null, customer?.area ?? null),
      },
      ...(customer?.address_2
        ? [
            {
              slot: 2,
              label: addressLabel(customer.address_2, customer.area_2 ?? null),
            },
          ]
        : []),
    ],
  };
}

/**
 * The customer's unpaid order and the days it asks for — the schedule that
 * `mark_paid` will turn into rows, and the only place those days exist until
 * then.
 *
 * `loadCustomerSchedule` reads rows, and an unpaid order has none, so without
 * this the prompt said "Belum ada pengiriman terjadwal" to a customer holding
 * five requested dinners. On 2026-09-23 Julian S dropped Saturday from his
 * unpaid order; the model had no tool it knew applied, confirmed in chat, and
 * the order still held the Saturday that payment would have put on the
 * kitchen sheet.
 *
 * Same lookup as extract_order's amend (newest `pending_payment`), so the order
 * shown here is the one a second extract_order call rewrites.
 */
export type PendingOrder = {
  id: string;
  packageSize: number;
  totalPrice: number;
  days: { date: string; mealType: string; portions: number }[];
};

export async function loadPendingOrder(
  db: Db,
  customerId: string,
): Promise<PendingOrder | null> {
  const { data } = await db
    .from("orders")
    .select("id, package_size, total_price, requested_schedule")
    .eq("customer_id", customerId)
    .eq("status", "pending_payment")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;

  const raw = Array.isArray(data.requested_schedule)
    ? (data.requested_schedule as {
        date?: string;
        meal_type?: string;
        portions?: number;
      }[])
    : [];
  return {
    id: data.id,
    packageSize: data.package_size ?? 0,
    totalPrice: data.total_price ?? 0,
    days: raw
      .filter((d) => typeof d?.date === "string")
      .map((d) => ({
        date: (d.date ?? "").slice(0, 10),
        mealType: d.meal_type ?? "lunch",
        portions: d.portions ?? 1,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Portions of one order bought but not yet delivered, as of `today`.
 *
 * This is the number an order is finished on, and it is not the same as
 * `unbookedByOrder` below: this one stops at today, that one counts the whole
 * calendar. The retired `orders.portions_remaining` column blurred the two —
 * it was decremented when a row was booked, so it reached 0 when the calendar
 * filled rather than when the food had gone out. Four orders were completed on
 * it while still owing 35 portions between them, Nadya's on 2026-08-13 with
 * twelve meals to come, which left her with no active order at all and the bot
 * with no quota context for her.
 */
export async function orderRemainingToday(
  db: Db,
  orderId: string,
  packageSize: number,
  today: string = jakartaDateString(),
): Promise<number> {
  const { data: rows } = await db
    .from("daily_deliveries")
    .select("portions")
    .eq("order_id", orderId)
    .lte("delivery_date", today);

  const drawn = (rows ?? []).reduce((s, r) => s + (r.portions ?? 0), 0);
  return packageSize - drawn;
}

/**
 * Portions each order has bought but not yet had delivered, keyed by order id —
 * the batch form of `orderRemainingToday`. This is "sisa makanan", the number a
 * customer means by sisa kuota, and it is not `unbookedByOrder` below: a
 * customer whose whole package is already dated has 0 unbooked and a full
 * balance still to eat.
 *
 * Batched because the renewal cron asks it of every active order at once, and
 * one round trip per order was 300 of them.
 */
export async function remainingTodayByOrder(
  db: Db,
  orders: { id: string; package_size: number | null }[],
  today: string = jakartaDateString(),
): Promise<Map<string, number>> {
  return sumRowsByOrder(db, orders, today);
}

/**
 * Portions each order has bought but not yet put on the calendar, keyed by
 * order id. The guard the sheet generators use before writing another row.
 *
 * Every row on the order counts, because every row on the order is a delivery
 * that will happen — a skipped one was deleted, not marked. This used to carve
 * out 'cancelled' and 'skipped' statuses; the column that held them is gone.
 *
 * The generators had no balance check at all, which is why reactivating a
 * wrongly-completed order was unsafe: `status = 'active'` plus a standing
 * `meal_time_preference` was the whole test, so every future Generate wrote
 * another row past the package. On 2026-08-20, 21 of the 28 rows the generator
 * built for the next day were already over-draws.
 */
export async function unbookedByOrder(
  db: Db,
  orders: { id: string; package_size: number | null }[],
): Promise<Map<string, number>> {
  return sumRowsByOrder(db, orders, null);
}

/**
 * package_size minus the order's delivery rows — up to `upTo` when given, and
 * across the whole calendar when null.
 *
 * Paginated with fetchAllRows: a fixed window would silently stop subtracting
 * once the table outgrew it, and every order past the cut would read as having
 * more balance than it has.
 */
async function sumRowsByOrder(
  db: Db,
  orders: { id: string; package_size: number | null }[],
  upTo: string | null,
): Promise<Map<string, number>> {
  const left = new Map<string, number>(
    orders.map((o) => [o.id, o.package_size ?? 0]),
  );
  if (orders.length === 0) return left;

  const { rows } = await fetchAllRows<{
    order_id: string | null;
    portions: number | null;
  }>((from, to) => {
    const q = db
      .from("daily_deliveries")
      .select("order_id, portions")
      .in(
        "order_id",
        orders.map((o) => o.id),
      );
    return (upTo ? q.lte("delivery_date", upTo) : q).range(from, to);
  });

  for (const row of rows) {
    if (!row.order_id) continue;
    const rest = left.get(row.order_id);
    if (rest === undefined) continue;
    left.set(row.order_id, rest - (row.portions ?? 0));
  }
  return left;
}

/**
 * Portions each customer has bought and not yet had delivered, keyed by
 * customer id — the batched, customer-level form of `loadCustomerSchedule`'s
 * `remainingToday`, and the same arithmetic the ledger drawer prints as
 * "Sisa hari ini".
 *
 * This is the only balance fit to write into a message to a customer.
 * `remainingTodayByOrder` above is a per-*order* figure and goes negative as an
 * ordinary artifact: which order a delivery is charged to is `pickDrawOrder`'s
 * business, and the June import's `package_size = 0` catch-all orders hold
 * other packages' rows outright. The renewal cron pasted that per-order number
 * into "paket kakak tinggal {remaining} porsi lagi" — on 2026-09-22 all 306
 * queued orders would have read "tinggal 0 porsi" or, at worst, "tinggal -100
 * porsi lagi". It inherited the shape from the dropped `orders.portions_remaining`
 * column, which was per order because it was a column on the order.
 *
 * Counted across every paid order, exactly as `loadCustomerSchedule` does, so
 * the reminder and the bot's own "sisa kuota" cannot disagree.
 */
export async function remainingTodayByCustomer(
  db: Db,
  customerIds: string[],
  today: string = jakartaDateString(),
): Promise<Map<string, number>> {
  const left = new Map<string, number>();
  if (customerIds.length === 0) return left;

  const [orders, draws] = await Promise.all([
    fetchAllRows<{ customer_id: string | null; package_size: number | null }>(
      (from, to) =>
        db
          .from("orders")
          .select("customer_id, package_size")
          .in("customer_id", customerIds)
          .in("status", PAID_STATUSES)
          .range(from, to),
    ),
    fetchAllRows<{ customer_id: string | null; portions: number | null }>(
      (from, to) =>
        db
          .from("daily_deliveries")
          .select("customer_id, portions")
          .in("customer_id", customerIds)
          .lte("delivery_date", today)
          .range(from, to),
    ),
  ]);

  for (const row of orders.rows) {
    if (!row.customer_id) continue;
    left.set(
      row.customer_id,
      (left.get(row.customer_id) ?? 0) + (row.package_size ?? 0),
    );
  }
  for (const row of draws.rows) {
    if (!row.customer_id) continue;
    const rest = left.get(row.customer_id);
    if (rest === undefined) continue;
    left.set(row.customer_id, rest - (row.portions ?? 0));
  }
  return left;
}
