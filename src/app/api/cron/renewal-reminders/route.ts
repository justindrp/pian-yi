import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { remainingTodayByCustomer } from "@/lib/orders/customer-schedule";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/utils/phone";
import { sendTextMessage } from "@/lib/whatsapp/client";
import { isDemoPhone } from "@/lib/whatsapp/demo";
import { WINDOW_NOTICE_SHORT } from "@/lib/whatsapp/window-notice";

type ActiveOrder = {
  id: string;
  customer_id: string | null;
  reminder_sent_at: string | null;
  followup_sent_at: string | null;
  customers: unknown;
};

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

  // Every active order, with what is left counted from the delivery rows. Both
  // queries below used to filter on `orders.portions_remaining`, a stored
  // counter that has been dropped — and they filtered with `=`, so an order
  // stepping from 4 to 2 portions in a day skipped the threshold and the
  // customer was never reminded at all. `<=` plus the sent-at flags is what
  // makes it fire once.
  const { data: activeOrders } = await db
    .from("orders")
    .select(
      "id, customer_id, reminder_sent_at, followup_sent_at, customers!orders_customer_id_fkey(phone_number, name)",
    )
    .eq("status", "active");

  // Twelve customers carry a placeholder phone from the legacy import
  // ("IMPORT_rima"), which Meta rejects and `sendTextMessage` throws on. That
  // throw escaped the loop and the whole route, and the first such customer sat
  // at position 0 of the first-reminder queue — so all 243 reminders died on her
  // every hour, and because `reminder_sent_at` is written *after* the send she
  // was never marked done and never skipped. Dropped before the loop rather than
  // attempted and failed hourly; a DEMO_ number is reachable, the client stubs
  // the send for it.
  const customerOf = (o: ActiveOrder) =>
    o.customers as { phone_number: string; name: string | null } | null;
  const reachable = (o: ActiveOrder) => {
    const phone = customerOf(o)?.phone_number;
    return isDemoPhone(phone) || normalizePhone(phone) !== null;
  };

  const orders = (activeOrders ?? []) as ActiveOrder[];

  // One reminder per customer, not per order. The balance quoted in the message
  // is a customer-level net, so looping orders would send 85 people the same
  // sentence carrying the same number two or three times over. The sent-at
  // flags stay on the orders because that is where the columns are: every
  // active order of that customer is stamped when the one message goes out.
  const byCustomer = new Map<string, ActiveOrder[]>();
  for (const o of orders) {
    if (!o.customer_id || !reachable(o)) continue;
    const list = byCustomer.get(o.customer_id);
    if (list) list.push(o);
    else byCustomer.set(o.customer_id, [o]);
  }

  // "Sisa hari ini" — bought across every paid order, minus every delivery
  // dated today or earlier. The same number the customer's ledger drawer shows
  // and the same one the bot answers "sisa kuota" with, so the two cannot
  // disagree. A negative here is a real over-draw (see docs/OVERDRAW.md), not
  // an accounting artifact — and still not a sentence to send anyone, so the
  // threshold test keeps its lower bound.
  const remaining = await remainingTodayByCustomer(db, [...byCustomer.keys()]);
  const under = (customerId: string, threshold: number) => {
    const left = remaining.get(customerId) ?? 0;
    return left > 0 && left <= threshold;
  };

  type Flag = "reminder_sent_at" | "followup_sent_at";

  const stamp = async (group: ActiveOrder[], column: Flag) => {
    const now = new Date().toISOString();
    await db
      .from("orders")
      .update(
        column === "reminder_sent_at"
          ? { reminder_sent_at: now }
          : { followup_sent_at: now },
      )
      .in(
        "id",
        group.map((o) => o.id),
      );
  };

  // One message per customer per run. A customer holding a reminded order and
  // a fresh un-reminded one matches both filters below, and without this would
  // be told twice in the same minute that their package is running out.
  const sentThisRun = new Set<string>();
  let failed = 0;

  const send = async (
    customerId: string,
    group: ActiveOrder[],
    template: string,
    column: Flag,
  ): Promise<boolean> => {
    const customer = customerOf(group[0]);
    if (!customer || sentThisRun.has(customerId)) return false;
    const msg = `${template
      .replace("{name}", customer.name ?? "kak")
      .replace("{remaining}", String(remaining.get(customerId) ?? 0))}\n\n${WINDOW_NOTICE_SHORT}`;
    // Per send, not around the loop: an uncaught throw here abandoned every
    // remaining customer, and a try/catch around the whole loop would too. The
    // stamp stays after the send so a failed send never marks someone reminded.
    try {
      await sendTextMessage(customer.phone_number, msg);
      await stamp(group, column);
      sentThisRun.add(customerId);
      return true;
    } catch (err) {
      failed++;
      console.error(`[renewal-reminders] ${column} failed:`, customer.name, err);
      return false;
    }
  };

  // First reminder — nothing of theirs reminded yet. `some` rather than `every`
  // so a top-up, which arrives as a fresh active order with null flags, gets
  // its own reminder cycle once that customer runs low again.
  const firstGroups = [...byCustomer.entries()].filter(
    ([customerId, group]) =>
      group.some((o) => o.reminder_sent_at === null) &&
      under(customerId, firstThreshold),
  );

  let firstSent = 0;
  for (const [customerId, group] of firstGroups) {
    if (await send(customerId, group, firstTemplate, "reminder_sent_at"))
      firstSent++;
  }

  // Final reminder — down to the final threshold, first reminder already sent,
  // followup not yet.
  const finalGroups = [...byCustomer.entries()].filter(
    ([customerId, group]) =>
      group.some(
        (o) => o.reminder_sent_at !== null && o.followup_sent_at === null,
      ) && under(customerId, finalThreshold),
  );

  let finalSent = 0;
  for (const [customerId, group] of finalGroups) {
    if (await send(customerId, group, finalTemplate, "followup_sent_at"))
      finalSent++;
  }

  return NextResponse.json({
    ok: true,
    firstReminders: firstSent,
    finalReminders: finalSent,
    failed,
    unreachable: orders.filter((o) => !reachable(o)).length,
  });
}

export const dynamic = "force-dynamic";
