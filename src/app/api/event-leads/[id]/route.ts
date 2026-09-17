import { type NextRequest, NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { isEventLeadStatus } from "@/lib/events/lead-status";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const { id } = await params;
  const body = (await req.json()) as {
    status?: string;
    event_date?: string | null;
    portions?: number | null;
    venue?: string | null;
    brief?: string | null;
    notes?: string | null;
    quoted_price_per_portion?: number | null;
    subcontractor_id?: string | null;
  };

  const allowed: Record<string, unknown> = {};
  if (body.status !== undefined) {
    if (!isEventLeadStatus(body.status))
      return NextResponse.json(
        { ok: false, error: "unknown status" },
        { status: 400 },
      );
    allowed.status = body.status;
    // Won and lost are both closed: what the date records is when we stopped
    // owing this lead an answer, not which way it went.
    allowed.closed_at =
      body.status === "won" || body.status === "lost"
        ? new Date().toISOString()
        : null;
  }
  if (body.event_date !== undefined) {
    if (
      body.event_date !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(body.event_date)
    )
      return NextResponse.json(
        { ok: false, error: "event_date must be YYYY-MM-DD" },
        { status: 400 },
      );
    allowed.event_date = body.event_date;
    // A moved date is a fresh deadline, so the sweep may speak about it again.
    allowed.last_nudged_at = null;
  }
  if (body.portions !== undefined) allowed.portions = body.portions;
  if (body.venue !== undefined) allowed.venue = body.venue;
  if (body.brief !== undefined) allowed.brief = body.brief;
  if (body.notes !== undefined) allowed.notes = body.notes;
  if (body.quoted_price_per_portion !== undefined)
    allowed.quoted_price_per_portion = body.quoted_price_per_portion;
  if (body.subcontractor_id !== undefined)
    allowed.subcontractor_id = body.subcontractor_id;

  if (Object.keys(allowed).length === 0)
    return NextResponse.json(
      { ok: false, error: "nothing to update" },
      { status: 400 },
    );

  const db = createAdminClient();
  const { data, error } = await db
    .from("event_leads")
    .update({ ...allowed, updated_at: new Date().toISOString() })
    .eq("id", id)
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
    entityId: id,
    action: "update",
    changes: allowed,
  });

  return NextResponse.json({ ok: true, data });
}

export const dynamic = "force-dynamic";
