import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { remainingTodayByOrder } from "@/lib/orders/customer-schedule";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";
import { WINDOW_NOTICE_SHORT } from "@/lib/whatsapp/window-notice";

export async function GET(req: NextRequest): Promise<Response> {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();
  const [firstWarningRaw, finalWarningRaw] = await Promise.all([
    getSetting("low_quota_first_warning"),
    getSetting("low_quota_final_warning"),
  ]);
  const firstThreshold = Number.parseInt(firstWarningRaw ?? "3", 10) || 3;
  const finalThreshold = Number.parseInt(finalWarningRaw ?? "1", 10) || 1;

  const [firstTemplate, finalTemplate] = await Promise.all([
    getTemplate("quota_low_first"),
    getTemplate("quota_low_final"),
  ]);

  // Every active order, with what is left on it counted from the delivery
  // rows. Both queries below used to filter on `orders.portions_remaining`, a
  // stored counter that has been dropped — and they filtered with `=`, so an
  // order stepping from 4 to 2 portions in a day skipped the threshold and the
  // customer was never reminded at all. `<=` plus the sent-at flags is what
  // makes it fire once.
  const { data: activeOrders } = await db
    .from("orders")
    .select(
      "id, customer_id, package_size, reminder_sent_at, followup_sent_at, customers!orders_customer_id_fkey(phone_number, name)",
    )
    .eq("status", "active");

  const remaining = await remainingTodayByOrder(db, activeOrders ?? []);
  const under = (id: string, threshold: number) =>
    (remaining.get(id) ?? 0) <= threshold;

  // First reminder
  const firstOrders = (activeOrders ?? []).filter(
    (o) => o.reminder_sent_at === null && under(o.id, firstThreshold),
  );

  for (const order of firstOrders) {
    const customer = order.customers as {
      phone_number: string;
      name: string | null;
    } | null;
    if (!customer) continue;
    const msg = `${firstTemplate
      .replace("{name}", customer.name ?? "kak")
      .replace(
        "{remaining}",
        String(remaining.get(order.id) ?? 0),
      )}\n\n${WINDOW_NOTICE_SHORT}`;
    await sendTextMessage(customer.phone_number, msg);
    await db
      .from("orders")
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq("id", order.id);
  }

  // Final reminder — down to the final threshold, first reminder already sent,
  // followup not yet.
  const finalOrders = (activeOrders ?? []).filter(
    (o) =>
      o.reminder_sent_at !== null &&
      o.followup_sent_at === null &&
      under(o.id, finalThreshold),
  );

  for (const order of finalOrders) {
    const customer = order.customers as {
      phone_number: string;
      name: string | null;
    } | null;
    if (!customer) continue;
    const msg = `${finalTemplate
      .replace("{name}", customer.name ?? "kak")
      .replace(
        "{remaining}",
        String(remaining.get(order.id) ?? 0),
      )}\n\n${WINDOW_NOTICE_SHORT}`;
    await sendTextMessage(customer.phone_number, msg);
    await db
      .from("orders")
      .update({ followup_sent_at: new Date().toISOString() })
      .eq("id", order.id);
  }

  return NextResponse.json({
    ok: true,
    firstReminders: firstOrders.length,
    finalReminders: finalOrders.length,
  });
}

export const dynamic = "force-dynamic";
