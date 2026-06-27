import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const dynamic = "force-dynamic";

// Only name, category, and is_active are editable. code/type/normal_balance are
// locked once an account exists to avoid corrupting historical postings.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!isOwner(session.role)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  let body: { name?: unknown; category?: unknown; is_active?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const update: { name?: string; category?: string; is_active?: boolean } = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ ok: false, error: "Nama akun wajib diisi" }, { status: 400 });
    update.name = name;
  }
  if (body.category !== undefined) {
    const category = typeof body.category === "string" ? body.category.trim() : "";
    if (!category) return NextResponse.json({ ok: false, error: "Kategori wajib diisi" }, { status: 400 });
    update.category = category;
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      return NextResponse.json({ ok: false, error: "is_active harus boolean" }, { status: 400 });
    }
    update.is_active = body.is_active;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: false, error: "Tidak ada perubahan" }, { status: 400 });
  }

  const db = createAdminClient();
  const { data, error } = await db
    .from("accounts")
    .update(update)
    .eq("id", id)
    .select("id, code, name, type, normal_balance, category, is_active")
    .single();

  if (error || !data) {
    return NextResponse.json({ ok: false, error: error?.message ?? "Akun tidak ditemukan" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, data });
}
