import { type NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  if (!date) return NextResponse.json({ ok: false, error: "date required" }, { status: 400 });

  const db = createAdminClient();

  // Load existing daily_deliveries for this date
  const { data: rows } = await db
    .from("daily_deliveries")
    .select("*, customers(name, phone_number, area, subcontractor_id), orders(portions_lunch, portions_dinner, portions_per_delivery, meal_time_preference)")
    .eq("delivery_date", date);

  return NextResponse.json({ ok: true, data: rows ?? [] });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { date: string };
  const date = body.date;
  if (!date) return NextResponse.json({ ok: false, error: "date required" }, { status: 400 });

  const db = createAdminClient();

  // Load active orders
  const { data: orders } = await db
    .from("orders")
    .select("id, customer_id, meal_time_preference, portions_lunch, portions_dinner, portions_per_delivery, pause_until, customers(name, phone_number, area, subcontractor_id)")
    .eq("status", "active");

  if (!orders) return NextResponse.json({ ok: true, data: [] });

  const targetDate = new Date(date);
  const dayOfWeek = targetDate.getDay(); // 0=Sun, 6=Sat

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

    // Skip paused
    if (order.pause_until && new Date(order.pause_until) >= targetDate) continue;

    const pref = order.meal_time_preference;

    const isLunch = pref === "lunch_only" || pref === "both_fixed" || pref === "keduanya" || pref === "default_lunch" || pref === "per_day_decision";
    const isDinner = pref === "dinner_only" || pref === "both_fixed" || pref === "keduanya" || pref === "default_dinner" || pref === "per_day_decision";

    if (isLunch && !order.customer_id) continue;

    if (isLunch) {
      rows.push({
        delivery_date: date,
        customer_id: order.customer_id as string,
        order_id: order.id,
        meal_type: "lunch",
        portions: (order.portions_lunch ?? 0) > 0 ? (order.portions_lunch ?? 0) : order.portions_per_delivery,
        subcontractor_id: customer.subcontractor_id,
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
        subcontractor_id: customer.subcontractor_id,
        status: "scheduled",
      });
    }
  }

  // Upsert
  if (rows.length > 0) {
    await db.from("daily_deliveries").upsert(rows, {
      onConflict: "delivery_date,customer_id,meal_type",
      ignoreDuplicates: true,
    });
  }

  return NextResponse.json({ ok: true, data: rows });
}

// Save: upsert rows and deduct portions_remaining
export async function PUT(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    date: string;
    rows: {
      id?: string;
      customer_id: string;
      order_id: string;
      meal_type: string;
      portions: number;
      subcontractor_id: string | null;
      notes: string | null;
      skip: boolean;
    }[];
  };

  const db = createAdminClient();

  for (const row of body.rows) {
    const status = row.skip ? "skipped" : "scheduled";
    await db.from("daily_deliveries").upsert(
      {
        delivery_date: body.date,
        customer_id: row.customer_id,
        order_id: row.order_id,
        meal_type: row.meal_type,
        portions: row.portions,
        subcontractor_id: row.subcontractor_id,
        notes: row.notes,
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "delivery_date,customer_id,meal_type" },
    );

    // Deduct portions_remaining for non-skipped rows
    if (!row.skip) {
      const { data: ord } = await db
        .from("orders")
        .select("portions_remaining")
        .eq("id", row.order_id)
        .single();
      if (ord && ord.portions_remaining !== null) {
        await db
          .from("orders")
          .update({ portions_remaining: Math.max(0, ord.portions_remaining - row.portions) })
          .eq("id", row.order_id);
      }
    }
  }

  await db.from("edit_log").insert({
    entity_type: "daily_deliveries",
    entity_id: body.date,
    action: "save_daily_sheet",
    changed_by: user.email ?? "",
    changes: { row_count: body.rows.length },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";

// Helper: load deadline hour
export async function getDeadlineHour(): Promise<number> {
  const raw = await getSetting("order_deadline_hour");
  return Number.parseInt(raw) || 20;
}
