import { type NextRequest, NextResponse } from "next/server";
import { createJournalEntry } from "@/lib/accounting/journal";
import { saveMessage, updateMessageReceipt } from "@/lib/claude/conversation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendTextMessage } from "@/lib/whatsapp/client";
import type { Database } from "@/types/database";

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

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
  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  return NextResponse.json({ ok: true, data });
}

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
    size?: "s" | "m";
    // Standing per-meal delivery-address rule (1=primary, 2=secondary/address_2)
    lunch_address_slot?: number;
    dinner_address_slot?: number;
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
    return NextResponse.json(
      { ok: false, error: "Missing required fields" },
      { status: 400 },
    );
  }

  const db = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);

  // Per-meal address slot: only 1 or 2 allowed; anything else falls back to 1.
  const lunchSlot = body.lunch_address_slot === 2 ? 2 : 1;
  const dinnerSlot = body.dinner_address_slot === 2 ? 2 : 1;

  if (body.order_type === "recurring") {
    if (!body.start_date || !body.meal_time_preference || !body.package_size) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "start_date, meal_time_preference, and package_size are required for recurring orders",
        },
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
        size: (body.size ?? "s") as "s" | "m",
        lunch_address_slot: lunchSlot,
        dinner_address_slot: dinnerSlot,
      })
      .select("id, order_type, status, total_price")
      .single();

    if (error)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    return NextResponse.json({ ok: true, data: order });
  }

  // Scheduled
  const schedule = body.delivery_schedule;
  if (!schedule || schedule.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "delivery_schedule is required for scheduled orders",
      },
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
      size: (body.size ?? "s") as "s" | "m",
      lunch_address_slot: lunchSlot,
      dinner_address_slot: dinnerSlot,
    })
    .select("id, order_type, status, total_price")
    .single();

  if (insertErr || !order)
    return NextResponse.json(
      { ok: false, error: insertErr?.message ?? "Insert failed" },
      { status: 500 },
    );

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
    address_slot: slot.meal_type === "dinner" ? dinnerSlot : lunchSlot,
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
      }).catch((err) =>
        console.error("[new_order] revenue journal error:", err),
      );

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
        }).catch((err) =>
          console.error("[new_order] cogs journal error:", err),
        );
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
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = (await req.json()) as {
    id: string;
    action: "mark_paid" | "update_size" | "update_fields" | "update_status";
    size?: "s" | "m";
    status?: string;
    fields?: Record<string, unknown>;
  };
  if (
    !body.id ||
    (body.action !== "mark_paid" &&
      body.action !== "update_size" &&
      body.action !== "update_fields" &&
      body.action !== "update_status")
  )
    return NextResponse.json(
      { ok: false, error: "Invalid request" },
      { status: 400 },
    );

  const db = createAdminClient();

  if (body.action === "update_size") {
    if (body.size !== "s" && body.size !== "m")
      return NextResponse.json(
        { ok: false, error: "Invalid size" },
        { status: 400 },
      );
    const { error } = await db
      .from("orders")
      .update({ size: body.size })
      .eq("id", body.id);
    if (error)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    return NextResponse.json({ ok: true });
  }

  if (body.action === "update_fields") {
    const f = body.fields ?? {};
    const update: Database["public"]["Tables"]["orders"]["Update"] = {
      updated_at: new Date().toISOString(),
    };

    // Allowlisted operational fields only — never money/quota/status/server columns.
    if ("area" in f) update.area = String(f.area);
    if ("delivery_address" in f)
      update.delivery_address = String(f.delivery_address);
    if ("maps_link" in f)
      update.maps_link = f.maps_link ? String(f.maps_link) : null;
    if ("subcontractor_id" in f)
      update.subcontractor_id = f.subcontractor_id
        ? String(f.subcontractor_id)
        : null;
    if ("meal_time_preference" in f)
      update.meal_time_preference = f.meal_time_preference
        ? String(f.meal_time_preference)
        : null;
    if ("end_date" in f)
      update.end_date = f.end_date ? String(f.end_date) : null;
    if ("portions_lunch" in f)
      update.portions_lunch =
        f.portions_lunch === null || f.portions_lunch === ""
          ? null
          : Number(f.portions_lunch);
    if ("portions_dinner" in f)
      update.portions_dinner =
        f.portions_dinner === null || f.portions_dinner === ""
          ? null
          : Number(f.portions_dinner);
    if ("portions_per_delivery" in f)
      update.portions_per_delivery = Number(f.portions_per_delivery);
    if ("lunch_address_slot" in f)
      update.lunch_address_slot = Number(f.lunch_address_slot) === 2 ? 2 : 1;
    if ("dinner_address_slot" in f)
      update.dinner_address_slot = Number(f.dinner_address_slot) === 2 ? 2 : 1;
    if ("size" in f) {
      if (f.size !== "s" && f.size !== "m")
        return NextResponse.json(
          { ok: false, error: "Invalid size" },
          { status: 400 },
        );
      update.size = f.size;
    }
    // Money/quota/date fields — editable per owner request. NOTE: raw edits here
    // do NOT re-post or adjust accounting journals; books can drift.
    if ("order_type" in f) update.order_type = String(f.order_type);
    if ("package_size" in f) update.package_size = Number(f.package_size);
    if ("portions_remaining" in f)
      update.portions_remaining = Number(f.portions_remaining);
    if ("price_per_portion" in f)
      update.price_per_portion = Number(f.price_per_portion);
    if ("total_price" in f) update.total_price = Number(f.total_price);
    if ("start_date" in f && f.start_date)
      update.start_date = String(f.start_date);
    if ("paid_at" in f) update.paid_at = f.paid_at ? String(f.paid_at) : null;

    const { error } = await db.from("orders").update(update).eq("id", body.id);
    if (error)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    return NextResponse.json({ ok: true });
  }

  if (body.action === "update_status") {
    const SAFE_STATUSES = ["paused", "completed", "cancelled_by_admin"];
    if (!body.status || !SAFE_STATUSES.includes(body.status))
      return NextResponse.json(
        { ok: false, error: "Invalid status" },
        { status: 400 },
      );
    const now = new Date().toISOString();
    const update: Database["public"]["Tables"]["orders"]["Update"] = {
      status: body.status,
      updated_at: now,
    };
    if (body.status === "completed") update.completed_at = now;
    if (body.status === "cancelled_by_admin") update.cancelled_at = now;
    const { error } = await db.from("orders").update(update).eq("id", body.id);
    if (error)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    return NextResponse.json({ ok: true });
  }

  // Fetch order + customer in one query
  const { data: order, error: fetchErr } = await db
    .from("orders")
    .select(
      "id, customer_id, total_price, package_size, start_date, end_date, meal_time_preference, portions_per_delivery, portions_lunch, portions_dinner, subcontractor_id, lunch_address_slot, dinner_address_slot, customers(name, phone_number)",
    )
    .eq("id", body.id)
    .single();
  if (fetchErr || !order)
    return NextResponse.json(
      { ok: false, error: "Order not found" },
      { status: 404 },
    );

  // Update order status
  const { error: updateErr } = await db
    .from("orders")
    .update({ status: "active", paid_at: new Date().toISOString() })
    .eq("id", body.id);
  if (updateErr)
    return NextResponse.json(
      { ok: false, error: updateErr.message },
      { status: 500 },
    );

  // Record conversion on first payment (fire-and-forget)
  const convCustomerId = order.customer_id;
  if (convCustomerId) {
    Promise.resolve(
      db
        .from("customers")
        .select("converted_at")
        .eq("id", convCustomerId)
        .single(),
    )
      .then(({ data: cust }) => {
        if (cust && !cust.converted_at) {
          const pkgSize = order.package_size ?? 0;
          return db
            .from("customers")
            .update({
              converted_at: new Date().toISOString(),
              total_portions: pkgSize,
              total_payment: order.total_price ?? 0,
              package: pkgSize > 0 ? `${pkgSize} porsi` : null,
            })
            .eq("id", convCustomerId);
        }
      })
      .catch((err: unknown) =>
        console.error("[mark_paid] conversion record error:", err),
      );
  }

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

  // Generate today's delivery row if today falls within the order date range and is a weekday
  {
    const todayStr = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Jakarta",
    });
    const dow = new Date(todayStr).getUTCDay(); // 0=Sun 6=Sat
    const isWeekday = dow >= 1 && dow <= 5;
    const inRange =
      todayStr >= (order.start_date ?? "") &&
      (!order.end_date || todayStr <= order.end_date);

    if (isWeekday && inRange) {
      type MealRow = {
        meal_type: "lunch" | "dinner";
        portions: number;
        address_slot: number;
      };
      const meals: MealRow[] = [];
      const pref = order.meal_time_preference;
      if (pref === "lunch_only" || pref === "default_lunch") {
        meals.push({
          meal_type: "lunch",
          portions: order.portions_lunch ?? order.portions_per_delivery ?? 1,
          address_slot: order.lunch_address_slot ?? 1,
        });
      } else if (pref === "dinner_only" || pref === "default_dinner") {
        meals.push({
          meal_type: "dinner",
          portions: order.portions_dinner ?? order.portions_per_delivery ?? 1,
          address_slot: order.dinner_address_slot ?? 1,
        });
      } else if (pref === "both_fixed") {
        meals.push({
          meal_type: "lunch",
          portions: order.portions_lunch ?? 1,
          address_slot: order.lunch_address_slot ?? 1,
        });
        meals.push({
          meal_type: "dinner",
          portions: order.portions_dinner ?? 1,
          address_slot: order.dinner_address_slot ?? 1,
        });
      }
      // per_day_decision and custom_schedule: customer decides day-by-day, skip auto-generation

      if (meals.length > 0) {
        Promise.all(
          meals.map(({ meal_type, portions, address_slot }) =>
            db.from("daily_deliveries").upsert(
              {
                order_id: body.id,
                customer_id: order.customer_id,
                delivery_date: todayStr,
                meal_type,
                portions,
                subcontractor_id: order.subcontractor_id ?? null,
                status: "scheduled",
                address_slot,
              },
              {
                onConflict: "order_id,delivery_date,meal_type",
                ignoreDuplicates: true,
              },
            ),
          ),
        ).catch((err) =>
          console.error("[mark_paid] delivery generation error:", err),
        );
      }
    }
  }

  // Send WhatsApp confirmation
  const rawCustomer = order.customers;
  const customer = (
    Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer
  ) as {
    name: string | null;
    phone_number: string;
  } | null;
  console.log(
    "[mark_paid] customer:",
    JSON.stringify(customer),
    "customer_id:",
    order.customer_id,
  );
  if (customer?.phone_number && order.customer_id) {
    const firstName = (customer.name ?? "").split(" ")[0] || "kak";
    const msg = `Halo kak ${firstName}! Pembayaran kamu sudah kami verifikasi dan pesananmu sekarang sudah aktif. Terima kasih ya kak, selamat menikmati! 🎉`;
    try {
      const conversationId = await saveMessage({
        customerId: order.customer_id,
        role: "assistant",
        content: msg,
      });
      const messageId = await sendTextMessage(customer.phone_number, msg);
      await updateMessageReceipt({
        conversationId,
        whatsappMessageId: messageId,
        status: "sent",
      });
      console.log("[mark_paid] WhatsApp sent to", customer.phone_number);
    } catch (err) {
      console.error("[mark_paid] WhatsApp send failed:", err);
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = (await req.json()) as { id?: string };
  if (!body.id)
    return NextResponse.json(
      { ok: false, error: "Missing order id" },
      { status: 400 },
    );

  const db = createAdminClient();

  const delDeliveries = await db
    .from("daily_deliveries")
    .delete()
    .eq("order_id", body.id);
  if (delDeliveries.error)
    return NextResponse.json(
      { ok: false, error: delDeliveries.error.message },
      { status: 500 },
    );

  const delOrder = await db.from("orders").delete().eq("id", body.id);
  if (delOrder.error)
    return NextResponse.json(
      { ok: false, error: delOrder.error.message },
      { status: 500 },
    );

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
