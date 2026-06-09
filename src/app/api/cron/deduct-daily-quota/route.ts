import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest): Promise<Response> {
  if (req.headers.get("Authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
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
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!deliveries || deliveries.length === 0) {
    return NextResponse.json({ ok: true, deducted: 0 });
  }

  const rows = deliveries.filter(
    (d): d is typeof d & { id: string; customer_id: string; order_id: string } =>
      d.id !== null && d.customer_id !== null && d.order_id !== null,
  );

  // Group portions by customer for a single read+update per customer
  const byCustomer = new Map<string, { totalPortions: number; deliveryIds: string[] }>();
  for (const d of rows) {
    const entry = byCustomer.get(d.customer_id) ?? { totalPortions: 0, deliveryIds: [] };
    entry.totalPortions += d.portions;
    entry.deliveryIds.push(d.id);
    byCustomer.set(d.customer_id, entry);
  }

  let deducted = 0;

  for (const [customerId, { totalPortions, deliveryIds }] of byCustomer) {
    const { data: cust } = await db
      .from("customers")
      .select("portions_remaining")
      .eq("id", customerId)
      .single();

    if (!cust) continue;

    const newRemaining = Math.max(0, cust.portions_remaining - totalPortions);

    await db
      .from("customers")
      .update({ portions_remaining: newRemaining })
      .eq("id", customerId);

    // Complete active orders when quota is exhausted
    if (newRemaining === 0) {
      await db
        .from("orders")
        .update({ status: "completed" })
        .eq("customer_id", customerId)
        .eq("status", "active");
    }

    // Mark delivery rows as deducted
    await db
      .from("daily_deliveries")
      .update({ quota_deducted: true })
      .in("id", deliveryIds);

    deducted += deliveryIds.length;
  }

  // Also deduct orders.portions_remaining per-row (tracks per-order balance)
  for (const d of rows) {
    const { data: ord } = await db
      .from("orders")
      .select("portions_remaining")
      .eq("id", d.order_id)
      .single();

    if (ord && ord.portions_remaining !== null) {
      await db
        .from("orders")
        .update({ portions_remaining: Math.max(0, ord.portions_remaining - d.portions) })
        .eq("id", d.order_id);
    }
  }

  console.log(`[deduct-daily-quota] deducted ${deducted} rows for ${tomorrowStr}`);
  return NextResponse.json({ ok: true, deducted, date: tomorrowStr });
}

export const dynamic = "force-dynamic";
