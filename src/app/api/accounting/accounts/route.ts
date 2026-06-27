import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const dynamic = "force-dynamic";

const TYPES = ["Asset", "Liability", "Equity", "Revenue", "Expense"] as const;
type AccountType = (typeof TYPES)[number];

// Asset & Expense increase on debit; Liability, Equity & Revenue increase on credit.
function normalBalanceFor(type: AccountType): "Debit" | "Credit" {
  return type === "Asset" || type === "Expense" ? "Debit" : "Credit";
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!isOwner(session.role)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const all = new URL(req.url).searchParams.get("all") === "true";
  const db = createAdminClient();

  // Full fields for the management view; trimmed active list for the journal dropdown.
  let query = all
    ? db.from("accounts").select("id, code, name, type, normal_balance, category, is_active")
    : db.from("accounts").select("code, name, type").eq("is_active", true);

  query = query.order("code", { ascending: true });

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, data: data ?? [] });
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!isOwner(session.role)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  let body: { code?: unknown; name?: unknown; type?: unknown; category?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const type = typeof body.type === "string" ? body.type.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";

  if (!/^\d{3,5}$/.test(code)) {
    return NextResponse.json({ ok: false, error: "Kode akun harus 3–5 digit angka" }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ ok: false, error: "Nama akun wajib diisi" }, { status: 400 });
  }
  if (!TYPES.includes(type as AccountType)) {
    return NextResponse.json({ ok: false, error: "Tipe akun tidak valid" }, { status: 400 });
  }
  if (!category) {
    return NextResponse.json({ ok: false, error: "Kategori wajib diisi" }, { status: 400 });
  }

  const db = createAdminClient();

  const { data: existing } = await db.from("accounts").select("id").eq("code", code).maybeSingle();
  if (existing) {
    return NextResponse.json({ ok: false, error: `Kode ${code} sudah dipakai` }, { status: 400 });
  }

  const { data, error } = await db
    .from("accounts")
    .insert({
      code,
      name,
      type,
      category,
      normal_balance: normalBalanceFor(type as AccountType),
      is_active: true,
    })
    .select("id, code, name, type, normal_balance, category, is_active")
    .single();

  if (error || !data) {
    return NextResponse.json({ ok: false, error: error?.message ?? "Gagal menyimpan akun" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, data });
}
