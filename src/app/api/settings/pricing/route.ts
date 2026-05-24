import { type NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { portions?: number; price_per_portion?: number; adjust?: number };
  const db = createAdminClient();

  if (typeof body.adjust === "number") {
    const { data: tiers, error: fetchError } = await db.from("pricing_tiers").select("portions, price_per_portion");
    if (fetchError) return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });

    await Promise.all(
      (tiers ?? []).map((t) =>
        db.from("pricing_tiers").update({ price_per_portion: t.price_per_portion + body.adjust! }).eq("portions", t.portions)
      )
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
      return NextResponse.json({ ok: false, error: "Missing fields" }, { status: 400 });
    }
    const { error } = await db
      .from("pricing_tiers")
      .update({ price_per_portion: body.price_per_portion })
      .eq("portions", body.portions);

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    await db.from("edit_log").insert({
      entity_type: "pricing_tiers",
      entity_id: String(body.portions),
      action: "update",
      changed_by: user.email ?? "",
      changes: { portions: body.portions, price_per_portion: body.price_per_portion },
    });
  }

  invalidateCache();
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
