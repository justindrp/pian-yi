import { type NextRequest, NextResponse } from "next/server";
import { createJournalEntry } from "@/lib/accounting/journal";
import { logEdit } from "@/lib/audit/log-edit";
import { saveMessage, updateMessageReceipt } from "@/lib/claude/conversation";
import { isDeliveryDay } from "@/lib/holidays/id";
import {
  remainingTodayByOrder,
  unbookedByOrder,
} from "@/lib/orders/customer-schedule";
import { orderHasDeliveries } from "@/lib/orders/order-has-deliveries";
import { kitchenCostPerPortion, normalizeSize } from "@/lib/orders/size";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendTextMessage } from "@/lib/whatsapp/client";
import { WINDOW_NOTICE_SHORT } from "@/lib/whatsapp/window-notice";
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
  const search = searchParams.get("search")?.trim();

  const db = createAdminClient();

  let customerIds: string[] | null = null;
  if (search) {
    const { data: matched } = await db
      .from("customers")
      .select("id")
      .or(`name.ilike.%${search}%,phone_number.ilike.%${search}%`);
    customerIds = (matched ?? []).map((c) => c.id);
    if (customerIds.length === 0)
      return NextResponse.json({ ok: true, data: [] });
  }

  // PostgREST caps a single response at 1000 rows, so page through the result
  // set — a fixed limit silently truncates the table once orders outgrow it.
  const PAGE = 1000;
  const page = (from: number) => {
    let q = db
      .from("orders")
      .select("*, customers!orders_customer_id_fkey(name, phone_number, area)")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (status) q = q.eq("status", status) as typeof q;
    if (customerIds) q = q.in("customer_id", customerIds) as typeof q;
    return q;
  };

  const rows: NonNullable<Awaited<ReturnType<typeof page>>["data"]> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from);
    if (error)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    rows.push(...(data ?? []));
    if (data.length < PAGE) break;
  }

  // Both "sisa" figures, counted from the delivery rows. The dropped
  // orders.portions_remaining column used to stand in for this and was neither
  // number reliably: it was decremented on booking, so it read 0 for a customer
  // whose whole package was already dated and still owed every meal.
  const [remainingToday, unbooked] = await Promise.all([
    remainingTodayByOrder(db, rows),
    unbookedByOrder(db, rows),
  ]);

  return NextResponse.json({
    ok: true,
    data: rows.map((o) => ({
      ...o,
      remaining_today: remainingToday.get(o.id) ?? 0,
      unbooked: unbooked.get(o.id) ?? 0,
    })),
  });
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
    price_per_portion: number;
    portions_per_delivery: number;
    subcontractor_id: string | null;
    status: "pending_payment" | "active" | "completed";
    start_date?: string;
    end_date?: string;
    portions_lunch?: number;
    portions_dinner?: number;
    package_size?: number;
    size?: "s" | "m";
    // What the kitchen charges us extra per portion for an add-on (nasi merah
    // and the like). Cost side only — the customer's share of it is already
    // inside price_per_portion, since we pass add-ons through at cost.
    addon_cost_per_portion?: number;
    // Standing per-meal delivery-address rule (1=primary, 2=secondary/address_2)
    lunch_address_slot?: number;
    dinner_address_slot?: number;
    // Optional. When present the customer's days are already decided, so the
    // rows are written here and package_size/start_date/end_date are derived
    // from them. When absent the order is a plain quota package and its
    // deliveries get written later, as the customer requests them.
    delivery_schedule?: {
      date: string;
      meal_type: "lunch" | "dinner";
      portions: number;
    }[];
  };

  if (
    !body.customer_id ||
    !body.price_per_portion ||
    !body.portions_per_delivery
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

  // Every order is the same product: a quota of portions. An optional
  // delivery_schedule says the customer's days are already decided, which only
  // changes where three numbers come from — an enumerated schedule already
  // states how many portions were bought and when the package starts and ends,
  // so deriving them here is safer than trusting the caller to send both.
  const schedule = body.delivery_schedule ?? [];
  const hasSchedule = schedule.length > 0;

  const packageSize = hasSchedule
    ? schedule.reduce((sum, s) => sum + s.portions, 0)
    : (body.package_size ?? 0);

  const dates = hasSchedule ? schedule.map((s) => s.date).sort() : [];
  const startDate = hasSchedule ? dates[0] : body.start_date;
  const endDate = hasSchedule
    ? dates[dates.length - 1]
    : (body.end_date ?? null);

  if (!packageSize || !startDate) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "package_size and start_date are required unless delivery_schedule is provided",
      },
      { status: 400 },
    );
  }

  const totalPrice = packageSize * body.price_per_portion;

  // The schedule is stored whether or not it is materialised below: an order
  // entered as pending_payment gets its rows at mark_paid, same as one the bot
  // created. A customer who decides day by day has no schedule to record and
  // books through record_daily_order instead.
  const { data: order, error: insertErr } = await db
    .from("orders")
    .insert({
      customer_id: body.customer_id,
      status: body.status,
      price_per_portion: body.price_per_portion,
      portions_per_delivery: body.portions_per_delivery,
      package_size: packageSize,
      total_price: totalPrice,
      subcontractor_id: body.subcontractor_id,
      start_date: startDate,
      end_date: endDate,
      requested_schedule: (hasSchedule ? schedule : null) as
        | Database["public"]["Tables"]["orders"]["Insert"]["requested_schedule"]
        | null,
      portions_lunch: body.portions_lunch ?? null,
      portions_dinner: body.portions_dinner ?? null,
      size: (body.size ?? "s") as "s" | "m",
      addon_cost_per_portion: Number(body.addon_cost_per_portion) || 0,
      lunch_address_slot: lunchSlot,
      dinner_address_slot: dinnerSlot,
    })
    .select("id, status, total_price")
    .single();

  if (insertErr || !order)
    return NextResponse.json(
      { ok: false, error: insertErr?.message ?? "Insert failed" },
      { status: 500 },
    );

  // Credit the customer-level counter. Only the free-quota route did this
  // before, so a purchased package left customers.portions_remaining at 0 while
  // the order itself held the full balance — which is what the Customers page
  // reads, and what the deduct-daily-quota cron used to close orders on.
  const { data: custQuota } = await db
    .from("customers")
    .select("portions_remaining")
    .eq("id", body.customer_id)
    .single();

  await db
    .from("customers")
    .update({
      portions_remaining: (custQuota?.portions_remaining ?? 0) + packageSize,
    })
    .eq("id", body.customer_id);

  await logEdit({
    db,
    actor: user.email ?? "",
    entityType: "orders",
    entityId: order.id,
    action: "create",
    changes: {
      customer_id: body.customer_id,
      package_size: packageSize,
      price_per_portion: body.price_per_portion,
      total_price: totalPrice,
      status: body.status,
      subcontractor_id: body.subcontractor_id,
      scheduled_dates: hasSchedule ? schedule.length : 0,
    },
  });

  if (!hasSchedule) return NextResponse.json({ ok: true, data: order });

  // An unpaid order gets no delivery rows. Nothing filters the kitchen sheet by
  // order status, so a row written here is food a kitchen will cook for an
  // order nobody has paid for. The schedule is already stored above; mark_paid
  // turns it into rows. An admin entering an order that is already active or
  // completed is recording food that is real — those rows are written below,
  // together with the revenue journals for any day already delivered.
  if (body.status === "pending_payment")
    return NextResponse.json({ ok: true, data: order });

  // Fetch subcontractor cost for COGS journals. M is a second dish the kitchen
  // bills us for, so it has its own rate — booking an M order at the S cost
  // reports a margin 3.000/porsi wider than it is. Fall back to the S rate when
  // the kitchen has no M rate on file rather than to zero.
  let subCost = 0;
  if (body.subcontractor_id) {
    const { data: sub } = await db
      .from("subcontractors")
      .select(
        "cost_per_portion, cost_per_portion_route1, cost_per_portion_m, cost_per_portion_route1_m",
      )
      .eq("id", body.subcontractor_id)
      .single();
    subCost = sub ? kitchenCostPerPortion(sub, normalizeSize(body.size), 2) : 0;
  }

  const deliveryRows = schedule.map((slot) => ({
    delivery_date: slot.date,
    customer_id: body.customer_id,
    order_id: order.id,
    meal_type: slot.meal_type,
    portions: slot.portions,
    subcontractor_id: body.subcontractor_id,
    address_slot: slot.meal_type === "dinner" ? dinnerSlot : lunchSlot,
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

    // The order needs no deduction: the past slots were just written as
    // delivery rows, and the order's balance is package_size minus its rows.
    const deliveredPortions = pastSlots.reduce((sum, s) => sum + s.portions, 0);

    // Mirror the deduction on the customer counter credited above, or a
    // backfilled order would leave the customer reading more quota than it has.
    const { data: c } = await db
      .from("customers")
      .select("portions_remaining")
      .eq("id", body.customer_id)
      .single();
    await db
      .from("customers")
      .update({
        portions_remaining: Math.max(
          0,
          (c?.portions_remaining ?? 0) - deliveredPortions,
        ),
      })
      .eq("id", body.customer_id);
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
    action:
      | "mark_paid"
      | "mark_payment_proof_received"
      | "reject_payment_proof"
      | "update_size"
      | "update_fields"
      | "update_status";
    size?: "s" | "m";
    status?: string;
    reason?: string;
    fields?: Record<string, unknown>;
  };
  if (
    !body.id ||
    (body.action !== "mark_paid" &&
      body.action !== "mark_payment_proof_received" &&
      body.action !== "reject_payment_proof" &&
      body.action !== "update_size" &&
      body.action !== "update_fields" &&
      body.action !== "update_status")
  )
    return NextResponse.json(
      { ok: false, error: "Invalid request" },
      { status: 400 },
    );

  const db = createAdminClient();

  if (body.action === "mark_payment_proof_received") {
    const { error } = await db
      .from("orders")
      .update({
        status: "payment_proof_received",
        payment_proof_received_at: new Date().toISOString(),
      })
      .eq("id", body.id)
      .eq("status", "pending_payment");
    if (error)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    await logEdit({
      db,
      actor: user.email ?? "",
      entityType: "orders",
      entityId: body.id,
      action: "mark_payment_proof_received",
      changes: { status: "payment_proof_received" },
    });
    return NextResponse.json({ ok: true });
  }

  // Rejecting a payment proof sends the order back to pending_payment with the
  // reason attached. The Payments screen used to do this straight from the
  // browser, which left no record of who rejected a customer's transfer.
  if (body.action === "reject_payment_proof") {
    const { error } = await db
      .from("orders")
      .update({
        status: "pending_payment",
        cancellation_reason: body.reason ?? null,
      })
      .eq("id", body.id);
    if (error)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    await logEdit({
      db,
      actor: user.email ?? "",
      entityType: "orders",
      entityId: body.id,
      action: "reject_payment_proof",
      changes: {
        status: "pending_payment",
        cancellation_reason: body.reason ?? null,
      },
    });
    return NextResponse.json({ ok: true });
  }

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
    await logEdit({
      db,
      actor: user.email ?? "",
      entityType: "orders",
      entityId: body.id,
      action: "update_size",
      changes: { size: body.size },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "update_fields") {
    const f = body.fields ?? {};
    const update: Database["public"]["Tables"]["orders"]["Update"] = {
      updated_at: new Date().toISOString(),
    };

    // Allowlisted operational fields only — never money/quota/status/server columns.
    if ("subcontractor_id" in f)
      update.subcontractor_id = f.subcontractor_id
        ? String(f.subcontractor_id)
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
    // Cost side, not customer money: the add-on changes what we owe the kitchen
    // per portion, never price_per_portion or total_price. Editing it only
    // affects COGS journals posted from here on — journals already written are
    // idempotent on source_id and have to be corrected by hand.
    if ("addon_cost_per_portion" in f)
      update.addon_cost_per_portion = Number(f.addon_cost_per_portion) || 0;
    // What has actually landed against the order. Corporate orders arrive with
    // a DP and settle later; total_price stays the contracted amount and this
    // records the part that has been received. Never derived — an admin types
    // it after checking the transfer.
    if ("amount_paid" in f) update.amount_paid = Number(f.amount_paid) || 0;
    if ("start_date" in f && f.start_date)
      update.start_date = String(f.start_date);

    const { error } = await db.from("orders").update(update).eq("id", body.id);
    if (error)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    await logEdit({
      db,
      actor: user.email ?? "",
      entityType: "orders",
      entityId: body.id,
      action: "update_fields",
      changes: update,
    });
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
    await logEdit({
      db,
      actor: user.email ?? "",
      entityType: "orders",
      entityId: body.id,
      action: "update_status",
      changes: update,
    });
    return NextResponse.json({ ok: true });
  }

  // Fetch order + customer in one query
  const { data: order, error: fetchErr } = await db
    .from("orders")
    .select(
      "id, customer_id, total_price, package_size, start_date, end_date, requested_schedule, portions_per_delivery, portions_lunch, portions_dinner, subcontractor_id, lunch_address_slot, dinner_address_slot, customers!orders_customer_id_fkey(name, phone_number, subcontractor_id)",
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

  await logEdit({
    db,
    actor: user.email ?? "",
    entityType: "orders",
    entityId: body.id,
    action: "mark_paid",
    changes: {
      status: "active",
      total_price: order.total_price,
      customer_id: order.customer_id,
    },
  });

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

  // Payment is when the food becomes real. Until now these rows were written at
  // order creation, while the order was still pending_payment, and nothing
  // filters the kitchen sheet by order status — GET /api/deliveries/daily-sheet
  // keys on delivery_date alone — so an unpaid order put portions in front of a
  // kitchen. Three orders were carrying 37 such portions on 2026-08-28.
  //
  // The days come off orders.requested_schedule, written once from the chat at
  // order creation. Nothing derives them here: a schedule the customer never
  // gave is not one we may invent, and this route used to invent a full
  // recurring pattern from a meal_time_preference enum that nobody had checked
  // against what the customer actually asked for.
  //
  // A null schedule is normal, not a failure — most customers buy quota and
  // book their days one at a time through record_daily_order.
  const alreadyScheduled = await orderHasDeliveries(body.id);
  const requested = (order.requested_schedule ?? null) as
    | { date: string; meal_type: string; portions: number }[]
    | null;

  if (Array.isArray(requested) && requested.length > 0 && !alreadyScheduled) {
    // We do not deliver on Minggu, and the kitchens are shut on libur
    // nasional, so a row on either is a delivery nobody cooks. Dropping the day
    // here leaves its portions unbooked, which is exactly right: the customer
    // still owns them and can move them. Minggu used to slip through — the
    // filter only asked about holidays, and a schedule the model wrote out by
    // date never passed through any weekday check.
    const deliveryRows = requested
      .filter((r) => isDeliveryDay(r.date))
      .map((r) => ({
        delivery_date: r.date,
        customer_id: order.customer_id,
        order_id: body.id,
        meal_type: r.meal_type,
        portions: r.portions,
        // The order's own kitchen is an override; the customer's is the
        // default. Without the fallback a delivery row carries a null
        // subcontractor_id, and /dapur/[id] filters strictly on it — so the
        // kitchen never sees the delivery. Julian S's whole renewal was
        // invisible that way.
        subcontractor_id:
          order.subcontractor_id ?? order.customers?.subcontractor_id ?? null,
        address_slot:
          r.meal_type === "dinner"
            ? (order.dinner_address_slot ?? 1)
            : (order.lunch_address_slot ?? 1),
      }));

    if (deliveryRows.length > 0) {
      const { error: deliveryErr } = await db
        .from("daily_deliveries")
        .upsert(deliveryRows, {
          onConflict: "delivery_date,customer_id,meal_type",
          ignoreDuplicates: true,
        });
      if (deliveryErr) {
        console.error("[mark_paid] delivery generation error:", deliveryErr);
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
    // The honorific lives in `greeting`, never in the sentence: a customer we
    // have no name for gets a clean "Halo kak!" instead of "Halo kak kak!".
    // Same doubling extract-order.ts already fixed for the payment request.
    const displayName = (customer.name ?? "").trim().split(" ")[0];
    const greeting = displayName ? `kak ${displayName}` : "kak";
    const msg = `Halo ${greeting}! Pembayaran kamu sudah kami verifikasi dan pesananmu sekarang sudah aktif. Terima kasih ya kak, selamat menikmati! 🎉\n\n${WINDOW_NOTICE_SHORT}`;
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

  // The order row is gone, so this line is the only remaining record that it
  // ever existed. Deleting an order also deletes its deliveries.
  await logEdit({
    db,
    actor: user.email ?? "",
    entityType: "orders",
    entityId: body.id,
    action: "delete",
    changes: { deleted_order_id: body.id, deleted_deliveries: true },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
