import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSetting } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

export async function GET(req: NextRequest): Promise<Response> {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const hoursRaw = await getSetting("unpaid_reminder_hours");
  const thresholdMs = (Number.parseInt(hoursRaw) || 2) * 3600 * 1000;
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();

  // Find customers in 'ordering' state with no order placed, last message > threshold ago
  const { data: stateRows } = await db
    .from("customer_state")
    .select("customer_id, customers(phone_number, name)")
    .eq("state", "ordering");

  let sent = 0;
  for (const row of stateRows ?? []) {
    const customer = row.customers as { phone_number: string; name: string | null } | null;
    if (!customer) continue;

    // Check last message time
    const { data: lastMsg } = await db
      .from("conversations")
      .select("created_at")
      .eq("customer_id", row.customer_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!lastMsg || !lastMsg.created_at || lastMsg.created_at > cutoff) continue;

    // Check no order placed in abandoned_recovery_sent_at
    const { data: order } = await db
      .from("orders")
      .select("id, abandoned_recovery_sent_at")
      .eq("customer_id", row.customer_id)
      .eq("status", "pending_payment")
      .is("abandoned_recovery_sent_at", null)
      .limit(1)
      .single();

    if (!order) continue;

    await sendTextMessage(
      customer.phone_number,
      "halo kak tadi mau lanjut order ya? tinggal ketik YA aja kalau mau konfirmasi 😊",
    );
    await db.from("orders").update({ abandoned_recovery_sent_at: new Date().toISOString() }).eq("id", order.id);
    sent++;
  }

  return NextResponse.json({ ok: true, sent });
}

export const dynamic = "force-dynamic";
