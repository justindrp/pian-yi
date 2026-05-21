import { type NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const db = createAdminClient();
  const [settingsRes, pricingRes, templatesRes, adminsRes] = await Promise.all([
    db.from("settings").select("*").order("key"),
    db.from("pricing_tiers").select("*").order("portions"),
    db.from("message_templates").select("*").order("key"),
    db.from("admin_users").select("email, created_at"),
  ]);

  return NextResponse.json({
    ok: true,
    data: {
      settings: settingsRes.data ?? [],
      pricing: pricingRes.data ?? [],
      templates: templatesRes.data ?? [],
      admins: adminsRes.data ?? [],
    },
  });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { updates: Record<string, string> };
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
