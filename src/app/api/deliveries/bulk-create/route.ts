import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    customer_id: string;
    deliveries: { date: string; meal_type: string; portions: number }[];
  };
  const { customer_id, deliveries } = body;

  if (!customer_id || !deliveries?.length) {
    return NextResponse.json({ ok: false, error: "Missing required fields" }, { status: 400 });
  }

  const db = createAdminClient();

  const { data: customer } = await db
    .from("customers")
    .select("subcontractor_id")
    .eq("id", customer_id)
    .single();

  if (!customer)
    return NextResponse.json({ ok: false, error: "Customer not found" }, { status: 404 });

  if (!customer.subcontractor_id) {
    return NextResponse.json(
      { ok: false, error: "Customer has no subcontractor assigned" },
      { status: 400 },
    );
  }

  const { data: order } = await db
    .from("orders")
    .select("id")
    .eq("customer_id", customer_id)
    .eq("status", "active")
    .eq("order_type", "recurring")
    .limit(1)
    .maybeSingle();

  const rows = deliveries.map((d) => ({
    delivery_date: d.date,
    customer_id,
    order_id: order?.id ?? null,
    meal_type: d.meal_type,
    portions: d.portions,
    subcontractor_id: customer.subcontractor_id,
    status: "scheduled",
  }));

  const { error } = await db.from("daily_deliveries").upsert(rows, {
    onConflict: "delivery_date,customer_id,meal_type",
    ignoreDuplicates: true,
  });

  if (error)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, data: { count: rows.length } });
}
