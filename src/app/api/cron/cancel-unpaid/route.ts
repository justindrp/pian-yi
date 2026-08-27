import { type NextRequest, NextResponse } from "next/server";
import { logEdit, systemActor } from "@/lib/audit/log-edit";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { jakartaDateString } from "@/lib/menu/week";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { addDays, jakartaHour } from "@/lib/time/jakarta";
import { sendTextMessage } from "@/lib/whatsapp/client";
import { WINDOW_NOTICE_SHORT } from "@/lib/whatsapp/window-notice";

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

  // Payment is due against the first delivery, not against the chat. This route
  // used to sweep on order age alone, and on 2026-08-27 that cancelled two
  // perfectly good orders: Naya confirmed 24 Aug for a 31 Aug start and Cindi
  // confirmed 21 Aug for a 2 Sep start, both of whom the bot had explicitly
  // told "boleh bayar H-1 atau hari H". Twenty-four hours after confirmation
  // they owed nothing yet. So an order only becomes overdue once the 16:00 H-1
  // deadline for its own `start_date` has passed — the same cutoff that governs
  // ordering, changes and skips.
  const deadlineHour =
    Number.parseInt(await getSetting("order_deadline_hour"), 10) || 16;
  // Once today's deadline has passed, tomorrow's starters are overdue too;
  // before it, they still have the rest of the day to transfer, so the hourly
  // runs before 16:00 WIB only reach orders whose start date has already come.
  const today = jakartaDateString();
  const latestOverdueStart =
    jakartaHour() >= deadlineHour ? addDays(today, 1) : today;

  // The FK hint is mandatory: `orders` reaches `customers` two ways —
  // `orders_customer_id_fkey` (orders.customer_id → customers.id, the one we
  // want) and `customers_linked_order_id_fkey` (customers.linked_order_id →
  // orders.id, pointing the other way). Without naming one, PostgREST refuses
  // the whole request with PGRST201 and returns no rows at all.
  const { data: orders, error } = await db
    .from("orders")
    .select(
      "id, customer_id, paid_by_customer_id, package_size, total_price, start_date, confirmed_at, customers!orders_customer_id_fkey(phone_number), payer:customers!orders_paid_by_customer_id_fkey(phone_number)",
    )
    .eq("status", "pending_payment")
    .lt("confirmed_at", cutoff)
    .lte("start_date", latestOverdueStart);

  // A failed query must not read as "nothing to cancel". This route ran hourly
  // for months on the ambiguous embed above: the error was discarded, `orders`
  // came back null, and the empty-result branch below returned `ok: true` —
  // which the scheduler recorded as a successful run. Zero orders were ever
  // cancelled and nothing ever alerted, because a broken query looked exactly
  // like a business with no unpaid orders. Fail loudly instead: a non-2xx is
  // logged by the scheduler and leaves `cron_runs` unstamped.
  if (error) {
    console.error("[cron/cancel-unpaid] order query failed:", error.message);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  if (!orders?.length) return NextResponse.json({ ok: true, cancelled: 0 });

  const template = await getTemplate("payment_overdue_final");
  let cancelled = 0;

  for (const order of orders) {
    // The notice goes to whoever owes the money. On a package bought for
    // someone else that is not the customer the order sits on: Cila never
    // spoke to us and has no open window, while Naya is the one who was given
    // the bank details and would be the one to re-order.
    const phone =
      (order.payer as { phone_number: string } | null)?.phone_number ??
      (order.customers as { phone_number: string } | null)?.phone_number;

    const reason = `Payment not received by the ${deadlineHour}:00 deadline the day before delivery`;

    try {
      // Same reason as the query above: an unchecked error here would count a
      // cancellation that never landed, and the count is what the admin push
      // and the response report.
      const { error: updateError } = await db
        .from("orders")
        .update({
          status: "cancelled_unpaid",
          cancelled_at: new Date().toISOString(),
          cancellation_reason: reason,
        })
        .eq("id", order.id);
      if (updateError) throw new Error(updateError.message);

      // An order cancelled by a person is traceable to them; this one used to
      // be traceable to nobody. On 2026-08-27 the first working run cancelled
      // three orders and `edit_log` recorded none of them, so reconstructing
      // what had happened meant reading the cron's source and inferring. After
      // the business write, never before — `logEdit` does not throw, and a
      // cancellation that landed must not be undone by a bookkeeping failure.
      await logEdit({
        db,
        actor: systemActor("cancel-unpaid"),
        entityType: "order",
        entityId: order.id,
        action: "cancel",
        changes: {
          reason,
          status: { from: "pending_payment", to: "cancelled_unpaid" },
          package_size: order.package_size,
          total_price: order.total_price,
          start_date: order.start_date,
          confirmed_at: order.confirmed_at,
          deadline_hour: deadlineHour,
          ...(order.paid_by_customer_id
            ? { paid_by_customer_id: order.paid_by_customer_id }
            : {}),
        },
      });

      if (phone)
        await sendTextMessage(phone, `${template}\n\n${WINDOW_NOTICE_SHORT}`);
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
