import { NextResponse } from "next/server";
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

  // Only customers with an active package can be added (draws come from a package).
  const data = (customers ?? [])
    .map((c) => ({ ...c, active_order: orderByCustomer.get(c.id) }))
    .filter((c): c is typeof c & { active_order: NonNullable<typeof c.active_order> } => c.active_order != null);

  return NextResponse.json({ ok: true, data });
}

export const dynamic = "force-dynamic";
