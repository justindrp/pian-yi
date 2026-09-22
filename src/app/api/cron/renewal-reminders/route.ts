import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { remainingTodayByOrder } from "@/lib/orders/customer-schedule";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/utils/phone";
import { sendTextMessage } from "@/lib/whatsapp/client";
import { isDemoPhone } from "@/lib/whatsapp/demo";
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
  // Low, but still a real balance. `remainingTodayByOrder` is per *order* —
  // `package_size` minus that order's rows — and a per-order balance goes
  // negative as an ordinary artifact, because the June import's
  // `package_size = 0` catch-all orders hold other packages' delivery rows.
  // The template pastes this number into the message ("tinggal {remaining}
  // porsi lagi"), so without the lower bound 306 of 306 queued customers would
  // have been told they had 0 or -100 portions left. The real balance is a
  // customer-level net, which this cron does not compute; until it does, an
  // order at or below zero is not something to write to anyone.
  const under = (id: string, threshold: number) => {
    const left = remaining.get(id) ?? 0;
    return left > 0 && left <= threshold;
  };

  // Twelve customers carry a placeholder phone from the legacy import
  // ("IMPORT_rima"), which Meta rejects and `sendTextMessage` throws on. That
  // throw escaped the loop and the whole route, and the first such customer sat
  // at position 0 of the first-reminder queue — so all 243 reminders died on her
  // every hour, and because `reminder_sent_at` is written *after* the send she
  // was never marked done and never skipped. Dropped before the loop rather than
  // attempted and failed hourly; a DEMO_ number is reachable, the client stubs
  // the send for it.
  const customerOf = (o: { customers: unknown }) =>
    o.customers as { phone_number: string; name: string | null } | null;
  const reachable = (o: { customers: unknown }) => {
    const phone = customerOf(o)?.phone_number;
    return isDemoPhone(phone) || normalizePhone(phone) !== null;
  };

  // First reminder
  const firstOrders = (activeOrders ?? []).filter(
    (o) =>
      o.reminder_sent_at === null && under(o.id, firstThreshold) && reachable(o),
  );

  let firstSent = 0;
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
    // Per send, not around the loop: an uncaught throw here abandoned every
    // remaining customer, and a try/catch around the whole loop would too. The
    // update stays after the send so a failed send never marks someone reminded.
    try {
      await sendTextMessage(customer.phone_number, msg);
      await db
        .from("orders")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", order.id);
      firstSent++;
    } catch (err) {
      console.error(
        "[renewal-reminders] first reminder failed:",
        order.id,
        err,
      );
    }
  }

  // Final reminder — down to the final threshold, first reminder already sent,
  // followup not yet.
  const finalOrders = (activeOrders ?? []).filter(
    (o) =>
      o.reminder_sent_at !== null &&
      o.followup_sent_at === null &&
      under(o.id, finalThreshold) &&
      reachable(o),
  );

  let finalSent = 0;
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
    try {
      await sendTextMessage(customer.phone_number, msg);
      await db
        .from("orders")
        .update({ followup_sent_at: new Date().toISOString() })
        .eq("id", order.id);
      finalSent++;
    } catch (err) {
      console.error(
        "[renewal-reminders] final reminder failed:",
        order.id,
        err,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    firstReminders: firstSent,
    finalReminders: finalSent,
    failed: firstOrders.length - firstSent + (finalOrders.length - finalSent),
    unreachable: (activeOrders ?? []).filter((o) => !reachable(o)).length,
  });
}

export const dynamic = "force-dynamic";
