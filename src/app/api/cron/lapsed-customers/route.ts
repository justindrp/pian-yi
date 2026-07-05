import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

export async function GET(req: NextRequest): Promise<Response> {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000).toISOString();

  // Mark customers with old completed orders and no current order as lapsed.
  const [{ data: activeOrders }, { data: completedOrders }] = await Promise.all(
    [
      db
        .from("orders")
        .select("customer_id")
        .in("status", [
          "active",
          "paused",
          "pending_payment",
          "payment_proof_received",
        ]),
      db
        .from("orders")
        .select("customer_id, completed_at")
        .eq("status", "completed")
        .not("completed_at", "is", null)
        .lt("completed_at", thirtyDaysAgo)
        .order("completed_at", { ascending: false }),
    ],
  );

  const activeCustomerIds = new Set(
    (activeOrders ?? [])
      .map((order) => order.customer_id)
      .filter((id): id is string => id !== null),
  );
  const lastCompletedByCustomer = new Map<string, string>();
  for (const order of completedOrders ?? []) {
    if (!order.customer_id || !order.completed_at) continue;
    if (!lastCompletedByCustomer.has(order.customer_id)) {
      lastCompletedByCustomer.set(order.customer_id, order.completed_at);
    }
  }

  const candidateCustomerIds = [...lastCompletedByCustomer.keys()].filter(
    (customerId) => !activeCustomerIds.has(customerId),
  );
  if (candidateCustomerIds.length > 0) {
    const { data: currentStates } = await db
      .from("customer_state")
      .select("customer_id, state")
      .in("customer_id", candidateCustomerIds);

    const stateByCustomerId = new Map(
      (currentStates ?? []).map((row) => [row.customer_id, row.state]),
    );
    for (const customerId of candidateCustomerIds) {
      const currentState = stateByCustomerId.get(customerId);
      if (currentState === "ordering" || currentState === "churned") continue;
      await db.from("customer_state").upsert(
        {
          customer_id: customerId,
          state: "lapsed",
          updated_at: now.toISOString(),
        },
        { onConflict: "customer_id" },
      );
    }
  }

  // Send reactivation messages to lapsed customers
  const { data: lapsedRows } = await db
    .from("customer_state")
    .select(
      "customer_id, reactivation_sent_at, reactivation_count, customers(phone_number, name)",
    )
    .eq("state", "lapsed");

  let sent = 0;
  for (const row of lapsedRows ?? []) {
    const customer = row.customers as {
      phone_number: string;
      name: string | null;
    } | null;
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

    const lapsedAt =
      lastOrder?.completed_at ?? lastOrder?.cancelled_at ?? thirtyDaysAgo;

    if (new Date(lapsedAt) < new Date(ninetyDaysAgo)) {
      // 90+ days: stop and mark churned
      await db
        .from("customer_state")
        .update({ state: "churned" })
        .eq("customer_id", row.customer_id);
      continue;
    }

    // Don't send if already sent within 30 days
    if (lastSent && new Date(lastSent) > new Date(thirtyDaysAgo)) continue;

    let msg: string;
    if (count === 0) {
      msg =
        "halo kak, udah lama ga order nih. menu lagi banyak yang baru loh, mau coba lagi? 😊";
    } else {
      msg = "Halo kak, kangen loh sama kakak 😊 Ada yang bisa kami bantu?";
    }

    await sendTextMessage(customer.phone_number, msg);
    await db
      .from("customer_state")
      .update({
        reactivation_sent_at: new Date().toISOString(),
        reactivation_count: count + 1,
      })
      .eq("customer_id", row.customer_id);
    sent++;
  }

  return NextResponse.json({ ok: true, sent });
}

export const dynamic = "force-dynamic";
