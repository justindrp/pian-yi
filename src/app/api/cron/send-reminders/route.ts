import { type NextRequest, NextResponse } from "next/server";
import { getSetting, getTemplate } from "@/lib/cache/settings";
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
  const reminderHoursStr = await getSetting("unpaid_reminder_hours");
  const reminderHours = Number.parseInt(reminderHoursStr, 10) || 2;

  const cutoff = new Date(
    Date.now() - reminderHours * 60 * 60 * 1000,
  ).toISOString();

  const { data: orders } = await db
    .from("orders")
    .select("id, customer_id, customers(phone_number)")
    .eq("status", "pending_payment")
    .lt("confirmed_at", cutoff)
    .is("reminder_sent_at", null);

  if (!orders?.length) return NextResponse.json({ ok: true, sent: 0 });

  const template = await getTemplate("payment_reminder_gentle");
  let sent = 0;

  for (const order of orders) {
    const phone = (order.customers as { phone_number: string } | null)
      ?.phone_number;
    if (!phone) continue;

    try {
      await sendTextMessage(phone, template);
      await db
        .from("orders")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", order.id);
      sent++;
    } catch (err) {
      console.error("[cron/send-reminders] error for order", order.id, err);
    }
  }

  return NextResponse.json({ ok: true, sent });
}
