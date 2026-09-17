import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSetting } from "@/lib/cache/settings";
import { OPEN_EVENT_LEAD_STATUSES } from "@/lib/events/lead-status";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";

// An event lead that is running out of time.
//
// A lead quoted on Monday for a Saturday event looks exactly the same on Friday
// as it did on Monday: nothing about `event_leads` ages by itself, and the
// escalation flag that put it in the inbox expires after 48 hours of customer
// silence (migration 104) — which is precisely when a quoted event most needs
// chasing. So something has to read the calendar.
//
// Deliberately quiet. One push per run naming every lead that needs an answer,
// and `last_nudged_at` keeps each lead to one mention a day: an admin shown the
// same three leads every hour reads none of them, which is how the Unanswered
// tab stopped being read before migration 104 fixed it.
//
// It never messages the customer. Every business-initiated send fails `131042`
// while the WABA restriction stands, and a lead waiting on a price is owed a
// human with a number, not a second robot.

export async function GET(req: NextRequest): Promise<Response> {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();
  const days = Number.parseInt(
    (await getSetting("event_lead_nudge_days")) ?? "3",
    10,
  );
  const window = Number.isFinite(days) && days > 0 ? days : 3;

  const todayWib = new Date(Date.now() + 7 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const horizon = new Date(Date.now() + 7 * 3600 * 1000);
  horizon.setUTCDate(horizon.getUTCDate() + window);
  const horizonYmd = horizon.toISOString().slice(0, 10);

  // An event whose date has already passed while still open is included: it is
  // either a job we did and never closed off, or one we lost by silence, and
  // both are things an admin has to settle rather than leave in the list.
  const { data: leads, error } = await db
    .from("event_leads")
    .select("id, customer_id, event_date, portions, status, last_nudged_at")
    .in("status", OPEN_EVENT_LEAD_STATUSES)
    .not("event_date", "is", null)
    .lte("event_date", horizonYmd)
    .order("event_date", { ascending: true });

  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  // One mention a day per lead. Compared against the WIB date rather than a
  // 24-hour clock, so the sweep speaks once each morning instead of drifting
  // an hour later every day.
  const due = (leads ?? []).filter(
    (l) =>
      !l.last_nudged_at ||
      new Date(new Date(l.last_nudged_at).getTime() + 7 * 3600 * 1000)
        .toISOString()
        .slice(0, 10) < todayWib,
  );

  if (due.length === 0)
    return NextResponse.json({ ok: true, data: { nudged: 0 } });

  const { data: customers } = await db
    .from("customers")
    .select("id, name, phone_number")
    .in(
      "id",
      due.map((l) => l.customer_id),
    );
  const nameOf = new Map(
    (customers ?? []).map((c) => [c.id, c.name || c.phone_number]),
  );

  const lines = due.map((l) => {
    const late = (l.event_date ?? "") < todayWib;
    return `${nameOf.get(l.customer_id) ?? "—"}: ${l.portions ?? "?"} porsi ${l.event_date}${late ? " (sudah lewat)" : ""} — ${l.status}`;
  });

  await sendPushToAllAdmins(
    due.length === 1
      ? "Acara belum dijawab"
      : `${due.length} acara belum dijawab`,
    lines.join("\n"),
    "/orders",
    "high",
  );

  await db
    .from("event_leads")
    .update({ last_nudged_at: new Date().toISOString() })
    .in(
      "id",
      due.map((l) => l.id),
    );

  return NextResponse.json({ ok: true, data: { nudged: due.length, lines } });
}

export const dynamic = "force-dynamic";
