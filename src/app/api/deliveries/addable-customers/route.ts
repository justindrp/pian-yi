import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Customers Agnes can manually add to a daily delivery sheet (e.g. a customer
// who decided to order for a date but has no auto-generated row). Each customer
// carries their active recurring order, if any, so the added row links an
// order_id — letting the nightly cron deduct quota and the save path post
// revenue/COGS journals. Customers with no active order can still be added as a
// logistics-only row (order_id null, no quota deduction).
export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const db = createAdminClient();

  const { data: orders } = await db
    .from("orders")
    .select(
      "id, customer_id, portions_per_delivery, portions_lunch, portions_dinner, meal_time_preference, size",
    )
    .eq("status", "active")
    .eq("order_type", "recurring");

  const orderByCustomer = new Map<string, NonNullable<typeof orders>[number]>();
  for (const o of orders ?? []) {
    if (o.customer_id && !orderByCustomer.has(o.customer_id)) {
      orderByCustomer.set(o.customer_id, o);
    }
  }

  const { data: customers, error } = await db
    .from("customers")
    .select(
      "id, name, phone_number, area, sub_area, address, google_maps_link, address_2, area_2, sub_area_2, google_maps_link_2, subcontractor_id, delivery_route, delivery_position",
    )
    .order("name");

  if (error)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const data = (customers ?? []).map((c) => ({
    ...c,
    active_order: orderByCustomer.get(c.id) ?? null,
  }));

  return NextResponse.json({ ok: true, data });
}

export const dynamic = "force-dynamic";
