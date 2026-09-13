import { type NextRequest, NextResponse } from "next/server";
import { accrueDeliveryDate } from "@/lib/accounting/accrue-deliveries";
import { logEdit, systemActor } from "@/lib/audit/log-edit";
import { jakartaDateString } from "@/lib/menu/week";
import { createAdminClient } from "@/lib/supabase/admin";
import { addDays } from "@/lib/time/jakarta";

/**
 * Recognises delivered days into the books.
 *
 * Revenue, COGS and ongkir accrual used to happen only when an admin pressed
 * Save on the Deliveries page. Rows reach `daily_deliveries` from four other
 * places, so the books quietly stopped on **21 Agustus 2026**, the last day
 * anyone used that button — three weeks with no revenue recognised and no
 * kitchen cost accrued, on food that was cooked and paid for.
 *
 * It walks a window rather than yesterday alone: a row can be added to a past
 * date (a correction, a late-entered order), and `accrueDeliveryDate` is
 * idempotent per date and meal, so re-walking a settled day costs one query
 * and writes nothing. The window is capped because a re-walk of the whole
 * history is a backfill, not a nightly job — pass `days` explicitly for that.
 *
 * Only dates that have already been delivered are touched. `date <= today` is
 * what "delivered" means here, the same test every other reader uses: a row on
 * a future date is a booking, and recognising revenue on it would be recording
 * a sale that has not happened.
 */
const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 120;

export async function POST(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(req.url);
  const requested = Number.parseInt(searchParams.get("days") ?? "", 10);
  const days =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_WINDOW_DAYS)
      : DEFAULT_WINDOW_DAYS;

  const db = createAdminClient();
  const today = jakartaDateString();
  const from = addDays(today, -days);

  // One query for the dates that actually have rows, rather than a loop over
  // every calendar day in the window: most of them are Minggu or libur at some
  // kitchen and hold nothing at all.
  const { data: rows, error } = await db
    .from("daily_deliveries")
    .select("delivery_date")
    .gte("delivery_date", from)
    .lte("delivery_date", today);

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  const dates = [...new Set((rows ?? []).map((r) => r.delivery_date))].sort();

  let revenue = 0;
  let cogs = 0;
  let ongkir = 0;
  const posted: string[] = [];

  for (const date of dates) {
    const totals = await accrueDeliveryDate(db, date);
    if (totals.revenue || totals.cogs || totals.ongkir) posted.push(date);
    revenue += totals.revenue;
    cogs += totals.cogs;
    ongkir += totals.ongkir;
  }

  if (posted.length > 0) {
    await logEdit({
      db,
      actor: systemActor("accrue-deliveries"),
      entityType: "journals",
      entityId: `${from}..${today}`,
      action: "accrue_deliveries",
      changes: { dates: posted, revenue, cogs, ongkir },
    });
  }

  return NextResponse.json({
    ok: true,
    data: {
      from,
      to: today,
      datesChecked: dates.length,
      datesPosted: posted.length,
      revenue,
      cogs,
      ongkir,
    },
  });
}
