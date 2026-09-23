import { type NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const db = createAdminClient();
  // Every active kitchen's own ladder. There is no house ladder (migration
  // 135), so the pricing editor picks a kitchen first.
  const [settingsRes, pricingRes, kitchensRes, templatesRes, adminsRes] =
    await Promise.all([
      db.from("settings").select("*").order("key"),
      db
        .from("pricing_tiers")
        .select("subcontractor_id, portions, price_per_portion")
        .order("portions"),
      db
        .from("subcontractors")
        .select("id, customer_nickname")
        .eq("is_active", true)
        .order("customer_nickname"),
      db.from("message_templates").select("*").order("key"),
      db.from("admin_users").select("email, created_at, role"),
    ]);

  return NextResponse.json({
    ok: true,
    data: {
      settings: settingsRes.data ?? [],
      pricing: pricingRes.data ?? [],
      kitchens: (kitchensRes.data ?? []).map((k) => ({
        id: k.id,
        nickname: k.customer_nickname ?? k.id,
      })),
      templates: templatesRes.data ?? [],
      admins: adminsRes.data ?? [],
    },
  });
}

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

  const body = (await req.json()) as { updates: Record<string, string> };
  const db = createAdminClient();

  for (const [key, value] of Object.entries(body.updates)) {
    await db.from("settings").upsert({ key, value }, { onConflict: "key" });
  }

  await db.from("edit_log").insert({
    entity_type: "settings",
    entity_id: "bulk",
    action: "update",
    changed_by: user.email ?? "",
    changes: body.updates,
  });

  invalidateCache();
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
