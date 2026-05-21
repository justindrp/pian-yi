import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

export async function GET(req: NextRequest): Promise<Response> {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000).toISOString();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000).toISOString();

  // Mark active_subscription customers with no active orders as lapsed
  const { data: stateRows } = await db
    .from("customer_state")
    .select("customer_id")
    .eq("state", "active_subscription");

  for (const row of stateRows ?? []) {
    const { data: activeOrders } = await db
      .from("orders")
      .select("id")
      .eq("customer_id", row.customer_id)
      .eq("status", "active")
      .limit(1);

    if (!activeOrders || activeOrders.length === 0) {
      // Check last completed order was >30 days ago
      const { data: lastOrder } = await db
        .from("orders")
        .select("completed_at")
        .eq("customer_id", row.customer_id)
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(1)
        .single();

      if (lastOrder?.completed_at && lastOrder.completed_at < thirtyDaysAgo) {
        await db.from("customer_state").update({ state: "lapsed" }).eq("customer_id", row.customer_id);
      }
    }
  }

  // Send reactivation messages to lapsed customers
  const { data: lapsedRows } = await db
    .from("customer_state")
    .select("customer_id, reactivation_sent_at, reactivation_count, customers(phone_number, name)")
    .eq("state", "lapsed");

  let sent = 0;
  for (const row of lapsedRows ?? []) {
    const customer = row.customers as { phone_number: string; name: string | null } | null;
    if (!customer) continue;

    const lastSent = row.reactivation_sent_at;
    const count = row.reactivation_count ?? 0;

    // Get when they lapsed
    const { data: lastOrder } = await db
      .from("orders")
      .select("completed_at, cancelled_at")
      .eq("customer_id", row.customer_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    const lapsedAt = lastOrder?.completed_at ?? lastOrder?.cancelled_at ?? thirtyDaysAgo;

    if (new Date(lapsedAt) < new Date(ninetyDaysAgo)) {
      // 90+ days: stop and mark churned
      await db.from("customer_state").update({ state: "churned" }).eq("customer_id", row.customer_id);
      continue;
    }

    // Don't send if already sent within 30 days
    if (lastSent && new Date(lastSent) > new Date(thirtyDaysAgo)) continue;

    let msg: string;
    if (count === 0) {
      msg = "halo kak, udah lama ga order nih. menu lagi banyak yang baru loh, mau coba lagi? 😊";
    } else {
      msg = "Halo kak, kangen loh sama kakak 😊 Ada yang bisa kami bantu?";
    }

    await sendTextMessage(customer.phone_number, msg);
    await db.from("customer_state").update({
      reactivation_sent_at: new Date().toISOString(),
      reactivation_count: count + 1,
    }).eq("customer_id", row.customer_id);
    sent++;
  }

  return NextResponse.json({ ok: true, sent });
}

export const dynamic = "force-dynamic";
