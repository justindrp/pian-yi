import { type NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { key: string; template: string };
  const db = createAdminClient();

  const { error } = await db
    .from("message_templates")
    .update({ template: body.template })
    .eq("key", body.key);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  await db.from("edit_log").insert({
    entity_type: "message_templates",
    entity_id: body.key,
    action: "update",
    changed_by: user.email ?? "",
    changes: { key: body.key },
  });

  invalidateCache();
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
