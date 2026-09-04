import { type NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Edits the house ladder, and only the house ladder.
 *
 * Every write here is scoped to `subcontractor_id IS NULL` (migration 098).
 * Both paths used to key on `portions` alone, which was exact while one ladder
 * existed and silently repriced every kitchen's row at that size the moment a
 * second one did — a bulk adjust of +1.000 would have moved Santapin and Homey
 * too, in the same request, with nothing in the UI saying so. A kitchen's own
 * ladder is not editable from this screen yet; it is set in SQL.
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
    portions?: number;
    price_per_portion?: number;
    adjust?: number;
  };
  const db = createAdminClient();

  if (typeof body.adjust === "number") {
    const adjust = body.adjust;
    const { data: tiers, error: fetchError } = await db
      .from("pricing_tiers")
      .select("portions, price_per_portion")
      .is("subcontractor_id", null);
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
          .is("subcontractor_id", null)
          .eq("portions", t.portions),
      ),
    );

    await db.from("edit_log").insert({
      entity_type: "pricing_tiers",
      entity_id: "all",
      action: "bulk_adjust",
      changed_by: user.email ?? "",
      changes: { adjust: body.adjust },
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
      .is("subcontractor_id", null)
      .eq("portions", body.portions);

    if (error)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );

    await db.from("edit_log").insert({
      entity_type: "pricing_tiers",
      entity_id: String(body.portions),
      action: "update",
      changed_by: user.email ?? "",
      changes: {
        portions: body.portions,
        price_per_portion: body.price_per_portion,
      },
    });
  }

  invalidateCache();
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
