import { type NextRequest, NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { OPEN_EVENT_LEAD_STATUSES } from "@/lib/events/lead-status";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * The event leads an admin still owes somebody an answer on.
 *
 * `?all=1` includes won and lost. The default is open only, because the page
 * this feeds is a worklist: a closed lead is history and history pushed to the
 * top of a worklist is how a list stops being read.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const all = req.nextUrl.searchParams.get("all") === "1";
  const db = createAdminClient();
  let query = db
    .from("event_leads")
    .select(
      "*, customers(id, name, phone_number), subcontractors(customer_nickname)",
    )
    // Undated leads sort last rather than first: a date we do not have is not
    // a deadline that has passed.
    .order("event_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (!all) query = query.in("status", OPEN_EVENT_LEAD_STATUSES);

  const { data, error } = await query;
  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  return NextResponse.json({ ok: true, data });
}

/** An enquiry that reached us by a route the bot never saw — a call, a DM. */
export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = (await req.json()) as {
    customer_id?: string;
    event_date?: string | null;
    portions?: number | null;
    venue?: string | null;
    brief?: string | null;
  };

  if (!body.customer_id)
    return NextResponse.json(
      { ok: false, error: "customer_id is required" },
      { status: 400 },
    );
  if (body.event_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(body.event_date))
    return NextResponse.json(
      { ok: false, error: "event_date must be YYYY-MM-DD" },
      { status: 400 },
    );

  const db = createAdminClient();
  const { data, error } = await db
    .from("event_leads")
    .insert({
      customer_id: body.customer_id,
      event_date: body.event_date ?? null,
      portions: body.portions ?? null,
      venue: body.venue ?? null,
      brief: body.brief ?? null,
      status: "brief",
    })
    .select()
    .single();

  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  await logEdit({
    db,
    actor: user.email ?? "",
    entityType: "event_leads",
    entityId: data.id,
    action: "create",
    changes: data,
  });

  return NextResponse.json({ ok: true, data });
}

export const dynamic = "force-dynamic";
