import { NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { invalidateCache } from "@/lib/cache/settings";
import { kitchenCoverageMap } from "@/lib/subcontractors/coverage";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";

/** Every kitchen's neighborhood rules, keyed by subcontractor id. */
export async function GET() {
  const session = await getSessionWithRole();
  if (!session)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const db = createAdminClient();
  try {
    return NextResponse.json({ ok: true, data: await kitchenCoverageMap(db) });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * Set one kitchen's rule for one neighborhood. Upsert rather than insert: the
 * editor toggles the same pair over and over, and a rule that says "serves it,
 * no surcharge" is the same as no row at all.
 */
export async function PUT(req: Request) {
  const session = await getSessionWithRole();
  if (!session)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = await req.json();
  const subcontractorId = body.subcontractor_id;
  const neighborhoodId = body.neighborhood_id;
  if (!subcontractorId || !neighborhoodId) {
    return NextResponse.json(
      { ok: false, error: "subcontractor_id and neighborhood_id required" },
      { status: 400 },
    );
  }

  const canDeliver = body.can_deliver !== false;
  const surcharge = Number(body.surcharge_per_delivery ?? 0);
  if (!Number.isInteger(surcharge) || surcharge < 0) {
    return NextResponse.json(
      { ok: false, error: "surcharge_per_delivery must be a whole Rp amount" },
      { status: 400 },
    );
  }

  const db = createAdminClient();
  const { data, error } = await db
    .from("subcontractor_neighborhoods")
    .upsert(
      {
        subcontractor_id: subcontractorId,
        neighborhood_id: neighborhoodId,
        can_deliver: canDeliver,
        surcharge_per_delivery: surcharge,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "subcontractor_id,neighborhood_id" },
    )
    .select("id")
    .single();

  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  await logEdit({
    db,
    actor: session.email,
    entityType: "subcontractor_neighborhoods",
    entityId: data.id,
    action: "update",
    changes: {
      subcontractor_id: subcontractorId,
      neighborhood_id: neighborhoodId,
      can_deliver: canDeliver,
      surcharge_per_delivery: surcharge,
    },
  });

  invalidateCache();
  return NextResponse.json({ ok: true, data });
}
