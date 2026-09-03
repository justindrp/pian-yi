import { NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { invalidateCache } from "@/lib/cache/settings";
import { knownDeliveryAreas } from "@/lib/subcontractors/areas";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";

export async function GET(req: Request) {
  const session = await getSessionWithRole();
  if (!session)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const { searchParams } = new URL(req.url);
  const area = searchParams.get("area");

  const db = createAdminClient();
  let query = db
    .from("area_neighborhoods")
    .select("id, area, name, excluded")
    .order("name");
  if (area) query = query.eq("area", area);

  const { data, error } = await query;
  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  return NextResponse.json({ ok: true, data });
}

export async function POST(req: Request) {
  const session = await getSessionWithRole();
  if (!session)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = await req.json();
  const area = body.area?.trim();
  const name = body.name?.trim();

  if (!area) {
    return NextResponse.json(
      { ok: false, error: "area required" },
      { status: 400 },
    );
  }
  if (!name) {
    return NextResponse.json(
      { ok: false, error: "name required" },
      { status: 400 },
    );
  }

  const db = createAdminClient();
  // The allowlist is whatever areas the kitchens actually carry — it used to be
  // a literal five-name array here, which would have rejected any area added to
  // a subcontractor afterwards.
  if (!(await knownDeliveryAreas(db)).includes(area)) {
    return NextResponse.json(
      { ok: false, error: "Invalid area" },
      { status: 400 },
    );
  }

  const { data, error } = await db
    .from("area_neighborhoods")
    .insert({ area, name })
    .select("id, area, name, excluded")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { ok: false, error: "Already exists" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  await logEdit({
    db,
    actor: session.email,
    entityType: "area_neighborhoods",
    entityId: data.id,
    action: "create",
    changes: { area, name },
  });

  invalidateCache();
  return NextResponse.json({ ok: true, data });
}

/**
 * Flips one neighbourhood between served and excluded.
 *
 * This is the alternative to deleting the row, and it is the one to reach for
 * when we will not deliver somewhere. A delete only stops the bot recognising
 * the name; the prompt's nearest-area rule then rounds the unrecognised cluster
 * into the nearest served area and sells to it anyway. An excluded row is
 * recognised and refused — see `exclusionFor()`.
 */
export async function PATCH(req: Request) {
  const session = await getSessionWithRole();
  if (!session)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = await req.json();
  const { id } = body;
  if (!id)
    return NextResponse.json(
      { ok: false, error: "id required" },
      { status: 400 },
    );
  if (typeof body.excluded !== "boolean")
    return NextResponse.json(
      { ok: false, error: "excluded required" },
      { status: 400 },
    );

  const db = createAdminClient();
  const { data, error } = await db
    .from("area_neighborhoods")
    .update({ excluded: body.excluded })
    .eq("id", id)
    .select("id, area, name, excluded")
    .single();

  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  await logEdit({
    db,
    actor: session.email,
    entityType: "area_neighborhoods",
    entityId: String(id),
    action: body.excluded ? "exclude" : "include",
    changes: { area: data.area, name: data.name, excluded: body.excluded },
  });

  invalidateCache();
  return NextResponse.json({ ok: true, data });
}

export async function DELETE(req: Request) {
  const session = await getSessionWithRole();
  if (!session)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = await req.json();
  const { id } = body;
  if (!id)
    return NextResponse.json(
      { ok: false, error: "id required" },
      { status: 400 },
    );

  const db = createAdminClient();
  const { error } = await db.from("area_neighborhoods").delete().eq("id", id);
  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  await logEdit({
    db,
    actor: session.email,
    entityType: "area_neighborhoods",
    entityId: String(id),
    action: "delete",
    changes: { neighborhood_id: id },
  });

  invalidateCache();
  return NextResponse.json({ ok: true });
}
