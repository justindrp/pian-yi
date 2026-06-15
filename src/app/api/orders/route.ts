import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { saveMessage } from "@/lib/claude/conversation";
import { sendTextMessage } from "@/lib/whatsapp/client";
import { createJournalEntry } from "@/lib/accounting/journal";

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");

  const db = createAdminClient();
  let query = db
    .from("orders")
    .select("*, customers(name, phone_number)")
    .order("created_at", { ascending: false })
    .limit(100);

  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}


export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    customer_id: string;
    order_type: "recurring" | "scheduled";
    price_per_portion: number;
    portions_per_delivery: number;
    delivery_address: string;
    area: string;
    subcontractor_id: string | null;
    status: "pending_payment" | "active" | "completed";
    // Recurring
    start_date?: string;
    end_date?: string;
    meal_time_preference?: string;
    portions_lunch?: number;
    portions_dinner?: number;
    package_size?: number;
    // Scheduled
    delivery_schedule?: {
      date: string;
      meal_type: "lunch" | "dinner";
      portions: number;
    }[];
  };

  if (
    !body.customer_id ||
    !body.order_type ||
    !body.price_per_portion ||
    !body.portions_per_delivery ||
    !body.area
  ) {
    return NextResponse.json({ ok: false, error: "Missing required fields" }, { status: 400 });
  }

  const db = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);

  if (body.order_type === "recurring") {
    if (!body.start_date || !body.meal_time_preference || !body.package_size) {
      return NextResponse.json(
        { ok: false, error: "start_date, meal_time_preference, and package_size are required for recurring orders" },
        { status: 400 },
      );
    }

    const totalPrice = body.package_size * body.price_per_portion;

    const { data: order, error } = await db
      .from("orders")
      .insert({
        customer_id: body.customer_id,
        order_type: "recurring",
        status: body.status,
        price_per_portion: body.price_per_portion,
        portions_per_delivery: body.portions_per_delivery,
        package_size: body.package_size,
        portions_remaining: body.package_size,
        total_price: totalPrice,
        delivery_address: body.delivery_address,
        area: body.area,
        subcontractor_id: body.subcontractor_id,
        start_date: body.start_date,
        end_date: body.end_date ?? null,
        meal_time_preference: body.meal_time_preference,
        portions_lunch: body.portions_lunch ?? null,
        portions_dinner: body.portions_dinner ?? null,
      })
      .select("id, order_type, status, total_price")
      .single();

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, data: order });
  }

  // Scheduled
  const schedule = body.delivery_schedule;
  if (!schedule || schedule.length === 0) {
    return NextResponse.json(
      { ok: false, error: "delivery_schedule is required for scheduled orders" },
      { status: 400 },
    );
  }

  const packageSize = schedule.reduce((sum, s) => sum + s.portions, 0);
  const totalPrice = packageSize * body.price_per_portion;
  const dates = schedule.map((s) => s.date).sort();
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  const { data: order, error: insertErr } = await db
    .from("orders")
    .insert({
      customer_id: body.customer_id,
      order_type: "scheduled",
      status: body.status,
      price_per_portion: body.price_per_portion,
      portions_per_delivery: body.portions_per_delivery,
      package_size: packageSize,
      portions_remaining: packageSize,
      total_price: totalPrice,
      delivery_address: body.delivery_address,
      area: body.area,
      subcontractor_id: body.subcontractor_id,
      start_date: startDate,
      end_date: endDate,
    })
    .select("id, order_type, status, total_price")
    .single();

  if (insertErr || !order)
    return NextResponse.json({ ok: false, error: insertErr?.message ?? "Insert failed" }, { status: 500 });

  // Fetch subcontractor cost for COGS journals
  let subCost = 0;
  if (body.subcontractor_id) {
    const { data: sub } = await db
      .from("subcontractors")
      .select("cost_per_portion")
      .eq("id", body.subcontractor_id)
      .single();
    subCost = sub?.cost_per_portion ?? 0;
  }

  const deliveryRows = schedule.map((slot) => ({
    delivery_date: slot.date,
    customer_id: body.customer_id,
    order_id: order.id,
    meal_type: slot.meal_type,
    portions: slot.portions,
    subcontractor_id: body.subcontractor_id,
    status: slot.date < today ? "delivered" : "scheduled",
  }));

  await db.from("daily_deliveries").upsert(deliveryRows, {
    onConflict: "delivery_date,customer_id,meal_type",
    ignoreDuplicates: true,
  });

  // Revenue recognition journals for past (already delivered) slots
  const pastSlots = schedule.filter((s) => s.date < today);
  if (pastSlots.length > 0) {
    const { createJournalEntry } = await import("@/lib/accounting/journal");

    // Fetch the inserted delivery rows to get their IDs
    const { data: insertedRows } = await db
      .from("daily_deliveries")
      .select("id, delivery_date, meal_type, portions")
      .eq("order_id", order.id)
      .lt("delivery_date", today);

    for (const row of insertedRows ?? []) {
      const revenueAmount = row.portions * body.price_per_portion;
      createJournalEntry({
        description: `Revenue recognition ${row.delivery_date} ${row.meal_type}`,
        date: row.delivery_date,
        sourceType: "delivery",
        sourceId: row.id,
        lines: [
          { accountCode: "2100", debit: revenueAmount, credit: 0 },
          { accountCode: "4001", debit: 0, credit: revenueAmount },
        ],
      }).catch((err) => console.error("[new_order] revenue journal error:", err));

      if (subCost > 0) {
        const cogsAmount = row.portions * subCost;
        createJournalEntry({
          description: `COGS ${row.delivery_date} ${row.meal_type}`,
          date: row.delivery_date,
          sourceType: "delivery_cogs",
          sourceId: row.id,
          lines: [
            { accountCode: "5001", debit: cogsAmount, credit: 0 },
            { accountCode: "2001", debit: 0, credit: cogsAmount },
          ],
        }).catch((err) => console.error("[new_order] cogs journal error:", err));
      }
    }

    // Deduct portions_remaining for past delivered slots
    const deliveredPortions = pastSlots.reduce((sum, s) => sum + s.portions, 0);
    await db
      .from("orders")
      .update({ portions_remaining: packageSize - deliveredPortions })
      .eq("id", order.id);
  }

  return NextResponse.json({ ok: true, data: order });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { id: string; action: "mark_paid" };
  if (!body.id || body.action !== "mark_paid")
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });

  const db = createAdminClient();

  // Fetch order + customer in one query
  const { data: order, error: fetchErr } = await db
    .from("orders")
    .select("id, customer_id, total_price, customers(name, phone_number)")
    .eq("id", body.id)
    .single();
  if (fetchErr || !order)
    return NextResponse.json({ ok: false, error: "Order not found" }, { status: 404 });

  // Update order status
  const { error: updateErr } = await db
    .from("orders")
    .update({ status: "active", paid_at: new Date().toISOString() })
    .eq("id", body.id);
  if (updateErr)
    return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });

  // Journal: Dr Bank BCA / Cr Uang Muka Pelanggan (full order value)
  const today = new Date().toISOString().slice(0, 10);
  createJournalEntry({
    description: `Penerimaan pembayaran pesanan`,
    date: today,
    sourceType: "order_payment",
    sourceId: body.id,
    lines: [
      { accountCode: "1002", debit: order.total_price ?? 0, credit: 0 },
      { accountCode: "2100", debit: 0, credit: order.total_price ?? 0 },
    ],
  }).catch((err) => console.error("[mark_paid] journal error:", err));

  // Send WhatsApp confirmation
  const rawCustomer = order.customers;
  const customer = (Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer) as {
    name: string | null;
    phone_number: string;
  } | null;
  console.log("[mark_paid] customer:", JSON.stringify(customer), "customer_id:", order.customer_id);
  if (customer?.phone_number && order.customer_id) {
    const firstName = (customer.name ?? "").split(" ")[0] || "kak";
    const msg = `Halo kak ${firstName}! Pembayaran kamu sudah kami verifikasi dan pesananmu sekarang sudah aktif. Terima kasih ya kak, selamat menikmati! 🎉`;
    try {
      await saveMessage({ customerId: order.customer_id, role: "assistant", content: msg });
      await sendTextMessage(customer.phone_number, msg);
      console.log("[mark_paid] WhatsApp sent to", customer.phone_number);
    } catch (err) {
      console.error("[mark_paid] WhatsApp send failed:", err);
    }
  }

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
