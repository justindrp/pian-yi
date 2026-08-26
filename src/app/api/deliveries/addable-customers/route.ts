import { NextResponse } from "next/server";
import { pickDrawOrder } from "@/lib/orders/pick-draw-order";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Customers Agnes can manually add to a daily delivery sheet (e.g. a customer
// who decided to draw extra from their package for a date but has no
// auto-generated row). A draw always comes from a package — customers cannot
// buy a fresh one-off — so only customers with an active recurring order are
// returned, and the added row always links that order_id (the nightly cron
// deducts quota and the save path posts revenue/COGS journals).
export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const db = createAdminClient();

  const { data: orders } = await db
    .from("orders")
    .select(
      "id, customer_id, portions_per_delivery, portions_lunch, portions_dinner, meal_time_preference, size, portions_remaining, start_date, created_at",
    )
    .eq("status", "active");

  // Group first, then pick per customer. Taking the first row a customer had in
  // this result was the old behaviour and it charged draws to whichever order
  // Postgres returned first — see pickDrawOrder for what that cost.
  const ordersByCustomer = new Map<string, NonNullable<typeof orders>>();
  const orderById = new Map<string, NonNullable<typeof orders>[number]>();
  for (const o of orders ?? []) {
    orderById.set(o.id, o);
    if (!o.customer_id) continue;
    const list = ordersByCustomer.get(o.customer_id);
    if (list) list.push(o);
    else ordersByCustomer.set(o.customer_id, [o]);
  }

  const orderByCustomer = new Map<string, NonNullable<typeof orders>[number]>();
  for (const [customerId, list] of ordersByCustomer) {
    const picked = pickDrawOrder(list);
    if (picked) orderByCustomer.set(customerId, picked);
  }

  const { data: customers, error } = await db
    .from("customers")
    .select(
      "id, name, phone_number, area, sub_area, address, google_maps_link, address_2, area_2, sub_area_2, google_maps_link_2, subcontractor_id, delivery_route, delivery_position, linked_order_id",
    )
    .order("name");

  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  // Own active order takes priority; otherwise fall back to the order this
  // customer is linked to (e.g. a kid drawing from a parent's package).
  const data = (customers ?? [])
    .map((c) => ({
      ...c,
      active_order:
        orderByCustomer.get(c.id) ??
        (c.linked_order_id ? orderById.get(c.linked_order_id) : undefined),
    }))
    .filter(
      (
        c,
      ): c is typeof c & { active_order: NonNullable<typeof c.active_order> } =>
        c.active_order != null,
    );

  return NextResponse.json({ ok: true, data });
}

export const dynamic = "force-dynamic";
