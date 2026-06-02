import { type NextRequest, NextResponse } from "next/server";
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

  // Skip if rows already exist for this date (e.g. cron ran twice)
  const { data: existing } = await db
    .from("daily_deliveries")
    .select("id")
    .eq("delivery_date", date)
    .limit(1);

  if (existing && existing.length > 0) {
    return NextResponse.json({ ok: true, skipped: true, date });
  }

  const { data: orders } = await db
    .from("orders")
    .select("id, customer_id, meal_time_preference, portions_lunch, portions_dinner, portions_per_delivery, pause_until, subcontractor_id, customers(name, phone_number, area, subcontractor_id)")
    .eq("status", "active")
    .lte("start_date", date);

  if (!orders?.length) return NextResponse.json({ ok: true, generated: 0, date });

  const targetDate = new Date(date);

  const rows: {
    delivery_date: string;
    customer_id: string;
    order_id: string;
    meal_type: string;
    portions: number;
    subcontractor_id: string | null;
    status: string;
  }[] = [];

  for (const order of orders) {
    const customer = order.customers as { name: string | null; phone_number: string; area: string; subcontractor_id: string | null } | null;
    if (!customer) continue;

    const subcontractorId = (order as unknown as { subcontractor_id: string | null }).subcontractor_id ?? customer.subcontractor_id;

    if (order.pause_until && new Date(order.pause_until) >= targetDate) continue;

    const pref = order.meal_time_preference;
    const isLunch = pref === "lunch_only" || pref === "both_fixed" || pref === "keduanya" || pref === "default_lunch" || pref === "per_day_decision";
    const isDinner = pref === "dinner_only" || pref === "both_fixed" || pref === "keduanya" || pref === "default_dinner" || pref === "per_day_decision";

    if (isLunch) {
      rows.push({
        delivery_date: date,
        customer_id: order.customer_id as string,
        order_id: order.id,
        meal_type: "lunch",
        portions: (order.portions_lunch ?? 0) > 0 ? (order.portions_lunch ?? 0) : order.portions_per_delivery,
        subcontractor_id: subcontractorId,
        status: "scheduled",
      });
    }

    if (isDinner) {
      rows.push({
        delivery_date: date,
        customer_id: order.customer_id as string,
        order_id: order.id,
        meal_type: "dinner",
        portions: (order.portions_dinner ?? 0) > 0 ? (order.portions_dinner ?? 0) : order.portions_per_delivery,
        subcontractor_id: subcontractorId,
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
