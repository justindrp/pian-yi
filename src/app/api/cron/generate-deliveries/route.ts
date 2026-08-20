import { type NextRequest, NextResponse } from "next/server";
import { FIXED_SCHEDULE_PREFS } from "@/lib/orders/build-recurring-deliveries";
import { unbookedByOrder } from "@/lib/orders/customer-schedule";
import { pickDrawOrder } from "@/lib/orders/pick-draw-order";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();

  // Generate for tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = tomorrow.toISOString().slice(0, 10);

  const { data: allOrders } = await db
    .from("orders")
    .select("id, customer_id, meal_time_preference, portions_lunch, portions_dinner, portions_per_delivery, lunch_address_slot, dinner_address_slot, pause_until, subcontractor_id, portions_remaining, package_size, start_date, created_at, customers!orders_customer_id_fkey(name, phone_number, area, subcontractor_id)")
    .eq("status", "active")
    .in("meal_time_preference", FIXED_SCHEDULE_PREFS)
    .lte("start_date", date);

  if (!allOrders?.length) return NextResponse.json({ ok: true, generated: 0, date });

  // One order per customer, same as the daily sheet's Generate button — two
  // standing orders would otherwise race for the same (date, customer, meal)
  // slot and the upsert would keep an arbitrary winner.
  const byCustomer = new Map<string, typeof allOrders>();
  for (const o of allOrders) {
    if (!o.customer_id) continue;
    const list = byCustomer.get(o.customer_id);
    if (list) list.push(o);
    else byCustomer.set(o.customer_id, [o]);
  }
  const orders = [...byCustomer.values()]
    .map((list) => pickDrawOrder(list))
    .filter((o): o is NonNullable<typeof o> => o != null);

  // Never write a row an order has no quota left to cover. Without this,
  // status = 'active' plus a standing meal_time_preference was the whole test,
  // so a fully-booked order kept generating rows past its package — 21 of the
  // 28 rows built for 2026-08-21 were already over-draws. It is also what makes
  // reactivating a wrongly-completed order safe: Nadya, Kurniadi Tan and Jordy
  // each have every owed portion already dated, so they generate nothing new.
  const unbooked = await unbookedByOrder(db, orders);

  const targetDate = new Date(date);

  const rows: {
    delivery_date: string;
    customer_id: string;
    order_id: string;
    meal_type: string;
    portions: number;
    subcontractor_id: string | null;
    address_slot: number;
    status: string;
  }[] = [];

  for (const order of orders) {
    const customer = order.customers as { name: string | null; phone_number: string; area: string; subcontractor_id: string | null } | null;
    if (!customer) continue;

    const subcontractorId = (order as unknown as { subcontractor_id: string | null }).subcontractor_id ?? customer.subcontractor_id;
    if (!subcontractorId) continue;

    if (order.pause_until && new Date(order.pause_until) >= targetDate) continue;

    // Fully booked: every portion already has a date. Nothing left to write.
    let left = unbooked.get(order.id) ?? 0;
    if (left <= 0) continue;

    const pref = order.meal_time_preference;
    const isLunch = pref === "lunch_only" || pref === "both_fixed" || pref === "keduanya" || pref === "default_lunch";
    const isDinner = pref === "dinner_only" || pref === "both_fixed" || pref === "keduanya" || pref === "default_dinner";

    const lunchPortions = (order.portions_lunch ?? 0) > 0 ? (order.portions_lunch ?? 0) : order.portions_per_delivery;
    if (isLunch && lunchPortions <= left) {
      left -= lunchPortions;
      rows.push({
        delivery_date: date,
        customer_id: order.customer_id as string,
        order_id: order.id,
        meal_type: "lunch",
        portions: lunchPortions,
        subcontractor_id: subcontractorId,
        address_slot: order.lunch_address_slot ?? 1,
        status: "scheduled",
      });
    }

    const dinnerPortions = (order.portions_dinner ?? 0) > 0 ? (order.portions_dinner ?? 0) : order.portions_per_delivery;
    if (isDinner && dinnerPortions <= left) {
      left -= dinnerPortions;
      rows.push({
        delivery_date: date,
        customer_id: order.customer_id as string,
        order_id: order.id,
        meal_type: "dinner",
        portions: dinnerPortions,
        subcontractor_id: subcontractorId,
        address_slot: order.dinner_address_slot ?? 1,
        status: "scheduled",
      });
    }
  }

  if (rows.length > 0) {
    await db.from("daily_deliveries").upsert(rows, {
      onConflict: "delivery_date,customer_id,meal_type",
      ignoreDuplicates: true,
    });
  }

  await db.from("edit_log").insert({
    entity_type: "daily_deliveries",
    entity_id: date,
    action: "cron_generate",
    changed_by: "cron",
    changes: { generated: rows.length },
  });

  return NextResponse.json({ ok: true, generated: rows.length, date });
}
