import { type NextRequest, NextResponse } from "next/server";
import { orderRemainingToday } from "@/lib/orders/customer-schedule";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest): Promise<Response> {
  if (
    req.headers.get("Authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  const { data: deliveries, error } = await db
    .from("daily_deliveries")
    .select("id, customer_id, order_id, portions")
    .eq("delivery_date", tomorrowStr)
    .eq("status", "scheduled")
    .eq("quota_deducted", false);

  if (error) {
    console.error("[deduct-daily-quota] fetch error:", error);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  if (!deliveries || deliveries.length === 0) {
    return NextResponse.json({ ok: true, deducted: 0 });
  }

  const rows = deliveries.filter(
    (
      d,
    ): d is typeof d & { id: string; customer_id: string; order_id: string } =>
      d.id !== null && d.customer_id !== null && d.order_id !== null,
  );

  // Group portions by customer for a single read+update per customer
  const byCustomer = new Map<
    string,
    { totalPortions: number; deliveryIds: string[] }
  >();
  for (const d of rows) {
    const entry = byCustomer.get(d.customer_id) ?? {
      totalPortions: 0,
      deliveryIds: [],
    };
    entry.totalPortions += d.portions;
    entry.deliveryIds.push(d.id);
    byCustomer.set(d.customer_id, entry);
  }

  let deducted = 0;

  // Deduct orders.portions_remaining per row first. This has to happen before
  // the completion check below, which reads the balance this loop writes.
  const touchedOrders = new Set<string>();
  for (const d of rows) {
    const { data: ord } = await db
      .from("orders")
      .select("portions_remaining")
      .eq("id", d.order_id)
      .single();

    if (ord && ord.portions_remaining !== null) {
      await db
        .from("orders")
        .update({
          portions_remaining: Math.max(0, ord.portions_remaining - d.portions),
        })
        .eq("id", d.order_id);
      touchedOrders.add(d.order_id);
    }
  }

  // Complete an order when that order's own food has actually been delivered.
  //
  // Before that it keyed on customers.portions_remaining instead, and complete
  // every active order the customer had whenever that counter hit zero. The
  // counter is only ever credited by the free-quota route — POST /api/orders
  // never credited it — so a purchased order left it at 0, the Math.max clamp
  // read 0 as "exhausted", and the order was closed with its full package
  // untouched. That is how Jordy's 5-porsi package was completed on
  // 2026-08-13 with 4 portions left, blocking his next delivery.
  for (const orderId of touchedOrders) {
    const { data: ord } = await db
      .from("orders")
      .select("status, package_size")
      .eq("id", orderId)
      .single();

    if (ord?.status !== "active") continue;

    // Finish on what has actually been delivered, never on the stored counter.
    // This loop deducts *tomorrow's* rows, and the daily-sheet PUT deducts on
    // save, so portions_remaining hits 0 when the calendar fills — not when the
    // food has gone out. Keying completion on it closed four orders still
    // owing 35 portions between them, Nadya's on 2026-08-13 with twelve meals
    // left to deliver. She then had no active order, so the bot lost her quota
    // context entirely.
    const left = await orderRemainingToday(db, orderId, ord.package_size ?? 0);
    if (left <= 0) {
      await db
        .from("orders")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", orderId)
        .eq("status", "active");
    }
  }

  for (const [customerId, { totalPortions, deliveryIds }] of byCustomer) {
    const { data: cust } = await db
      .from("customers")
      .select("portions_remaining")
      .eq("id", customerId)
      .single();

    if (!cust) continue;

    await db
      .from("customers")
      .update({
        portions_remaining: Math.max(0, cust.portions_remaining - totalPortions),
      })
      .eq("id", customerId);

    // Mark delivery rows as deducted
    await db
      .from("daily_deliveries")
      .update({ quota_deducted: true })
      .in("id", deliveryIds);

    deducted += deliveryIds.length;
  }

  console.log(
    `[deduct-daily-quota] deducted ${deducted} rows for ${tomorrowStr}`,
  );
  return NextResponse.json({ ok: true, deducted, date: tomorrowStr });
}

export const dynamic = "force-dynamic";
