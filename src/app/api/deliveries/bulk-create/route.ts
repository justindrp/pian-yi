import { type NextRequest, NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { unbookedByOrder } from "@/lib/orders/customer-schedule";
import { pickDrawOrder } from "@/lib/orders/pick-draw-order";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = (await req.json()) as {
    customer_id: string;
    deliveries: { date: string; meal_type: string; portions: number }[];
  };
  const { customer_id, deliveries } = body;

  if (!customer_id || !deliveries?.length) {
    return NextResponse.json(
      { ok: false, error: "Missing required fields" },
      { status: 400 },
    );
  }

  const db = createAdminClient();

  const { data: customer } = await db
    .from("customers")
    .select("subcontractor_id")
    .eq("id", customer_id)
    .single();

  if (!customer)
    return NextResponse.json(
      { ok: false, error: "Customer not found" },
      { status: 404 },
    );

  if (!customer.subcontractor_id) {
    return NextResponse.json(
      { ok: false, error: "Customer has no subcontractor assigned" },
      { status: 400 },
    );
  }

  // Every active order, then pick — `.limit(1)` with no ORDER BY took whichever
  // row came back first, which for a customer holding two packages was the one
  // created earliest, drained or not. The balance each one is picked on is
  // counted from its delivery rows; the stored counter it used to read is gone.
  const { data: activeOrders } = await db
    .from("orders")
    .select("id, package_size, start_date, created_at")
    .eq("customer_id", customer_id)
    .eq("status", "active");

  const unbooked = await unbookedByOrder(db, activeOrders ?? []);
  const order = pickDrawOrder(
    (activeOrders ?? []).map((o) => ({ ...o, unbooked: unbooked.get(o.id) ?? 0 })),
  );

  if (!order) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Customer has no active order — cannot create draws without balance",
      },
      { status: 400 },
    );
  }

  const rows = deliveries.map((d) => ({
    delivery_date: d.date,
    customer_id,
    order_id: order?.id ?? null,
    meal_type: d.meal_type,
    portions: d.portions,
    subcontractor_id: customer.subcontractor_id,
  }));

  const { error } = await db.from("daily_deliveries").upsert(rows, {
    onConflict: "delivery_date,customer_id,meal_type",
    ignoreDuplicates: true,
  });

  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  await logEdit({
    db,
    actor: user.email ?? "",
    entityType: "daily_deliveries",
    entityId: customer_id,
    action: "bulk_create",
    changes: { order_id: order.id, deliveries },
  });

  return NextResponse.json({ ok: true, data: { count: rows.length } });
}
