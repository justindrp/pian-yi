import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { email } = await req.json() as { email: string };
  if (!email || !email.includes("@")) return NextResponse.json({ ok: false, error: "Invalid email" }, { status: 400 });

  const db = createAdminClient();
  const normalized = email.toLowerCase().trim();
  const name = normalized.split("@")[0];
  const { error } = await db.from("admin_users").insert({ email: normalized, name });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });

  await db.from("edit_log").insert({
    entity_type: "admin_users",
    entity_id: email,
    action: "insert",
    changed_by: user.email ?? "",
    changes: { email },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { email } = await req.json() as { email: string };
  if (email === user.email) return NextResponse.json({ ok: false, error: "Cannot remove yourself" }, { status: 400 });

  const db = createAdminClient();
  const { error } = await db.from("admin_users").delete().eq("email", email);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });

  await db.from("edit_log").insert({
    entity_type: "admin_users",
    entity_id: email,
    action: "delete",
    changed_by: user.email ?? "",
    changes: { email },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
