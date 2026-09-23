import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Edits one kitchen's ladder, and only that kitchen's.
 *
 * Every write here is scoped to the `subcontractor_id` in the body. Both paths
 * used to key on `portions` alone, which was exact while one ladder existed
 * and silently repriced every kitchen's row at that size the moment a second
 * one did — a bulk adjust of +1.000 would have moved Santapin and Homey too,
 * in the same request, with nothing in the UI saying so. This screen edited
 * the house ladder (`subcontractor_id IS NULL`) until migration 135 moved
 * those rows onto Thenie, whose prices they always were.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
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
    subcontractor_id?: string;
    portions?: number;
    price_per_portion?: number;
    adjust?: number;
  };
  const kitchen = body.subcontractor_id;
  if (!kitchen)
    return NextResponse.json(
      { ok: false, error: "subcontractor_id required" },
      { status: 400 },
    );
  const db = createAdminClient();

  if (typeof body.adjust === "number") {
    const adjust = body.adjust;
    const { data: tiers, error: fetchError } = await db
      .from("pricing_tiers")
      .select("portions, price_per_portion")
      .eq("subcontractor_id", kitchen);
    if (fetchError)
      return NextResponse.json(
        { ok: false, error: fetchError.message },
        { status: 500 },
      );

    await Promise.all(
      (tiers ?? []).map((t) =>
        db
          .from("pricing_tiers")
          .update({ price_per_portion: t.price_per_portion + adjust })
          .eq("subcontractor_id", kitchen)
          .eq("portions", t.portions),
      ),
    );

    await db.from("edit_log").insert({
      entity_type: "pricing_tiers",
      entity_id: kitchen,
      action: "bulk_adjust",
      changed_by: user.email ?? "",
      changes: { subcontractor_id: kitchen, adjust: body.adjust },
    });
  } else {
    if (body.portions === undefined || body.price_per_portion === undefined) {
      return NextResponse.json(
        { ok: false, error: "Missing fields" },
        { status: 400 },
      );
    }
    const { error } = await db
      .from("pricing_tiers")
      .update({ price_per_portion: body.price_per_portion })
      .eq("subcontractor_id", kitchen)
      .eq("portions", body.portions);

    if (error)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );

    await db.from("edit_log").insert({
      entity_type: "pricing_tiers",
      entity_id: `${kitchen}:${body.portions}`,
      action: "update",
      changed_by: user.email ?? "",
      changes: {
        subcontractor_id: kitchen,
        portions: body.portions,
        price_per_portion: body.price_per_portion,
      },
    });
  }

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
