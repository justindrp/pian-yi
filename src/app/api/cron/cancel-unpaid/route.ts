import { type NextRequest, NextResponse } from "next/server";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

export async function POST(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();
  const cancelHoursStr = await getSetting("unpaid_cancel_hours");
  const cancelHours = Number.parseInt(cancelHoursStr, 10) || 24;

  const cutoff = new Date(
    Date.now() - cancelHours * 60 * 60 * 1000,
  ).toISOString();

  const { data: orders } = await db
    .from("orders")
    .select("id, customer_id, customers(phone_number)")
    .eq("status", "pending_payment")
    .lt("confirmed_at", cutoff);

  if (!orders?.length) return NextResponse.json({ ok: true, cancelled: 0 });

  const template = await getTemplate("payment_overdue_final");
  let cancelled = 0;

  for (const order of orders) {
    const phone = (order.customers as { phone_number: string } | null)
      ?.phone_number;

    try {
      await db
        .from("orders")
        .update({
          status: "cancelled_unpaid",
          cancelled_at: new Date().toISOString(),
          cancellation_reason: "Payment not received within 24 hours",
        })
        .eq("id", order.id);

      if (phone) await sendTextMessage(phone, template);
      cancelled++;
    } catch (err) {
      console.error("[cron/cancel-unpaid] error for order", order.id, err);
    }
  }

  if (cancelled > 0) {
    await sendPushToAllAdmins(
      `${cancelled} order(s) auto-cancelled`,
      "Unpaid orders cancelled after 24h",
      "/payments",
      "low",
    );
  }

  return NextResponse.json({ ok: true, cancelled });
}
