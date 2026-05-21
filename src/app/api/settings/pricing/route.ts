import { type NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { portions: number; price_per_portion: number };
  const db = createAdminClient();

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

  invalidateCache();
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
