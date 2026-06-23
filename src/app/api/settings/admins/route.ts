import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { email, role } = await req.json() as { email: string; role?: string };
  if (!email || !email.includes("@")) return NextResponse.json({ ok: false, error: "Invalid email" }, { status: 400 });
  const resolvedRole = role === "owner" ? "owner" : "admin";

  const db = createAdminClient();
  const normalized = email.toLowerCase().trim();
  const name = normalized.split("@")[0];
  const { error } = await db.from("admin_users").insert({ email: normalized, name, role: resolvedRole });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });

  // Create the Supabase Auth account so OTP login works (signups are disabled)
  await db.auth.admin.createUser({ email: normalized, email_confirm: true });

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

  // Remove the Supabase Auth account too
  const { data: { users } } = await db.auth.admin.listUsers({ perPage: 1000 });
  const authUser = users.find((u) => u.email === email.toLowerCase().trim());
  if (authUser) await db.auth.admin.deleteUser(authUser.id);

  await db.from("edit_log").insert({
    entity_type: "admin_users",
    entity_id: email,
    action: "delete",
    changed_by: user.email ?? "",
    changes: { email },
  });

  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { email, role } = await req.json() as { email: string; role: string };
  if (!email || (role !== "admin" && role !== "owner")) return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });

  const db = createAdminClient();
  const { error } = await db.from("admin_users").update({ role }).eq("email", email.toLowerCase().trim());
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });

  await db.from("edit_log").insert({
    entity_type: "admin_users",
    entity_id: email,
    action: "update",
    changed_by: user.email ?? "",
    changes: { role },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
