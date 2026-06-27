import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const dynamic = "force-dynamic";

interface RawLine {
  debit: number;
  credit: number;
  journals: { reference: string; description: string; date: string } | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!isOwner(session.role)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("account") ?? "";
  const from = searchParams.get("from");
  const to = searchParams.get("to") ?? new Date().toISOString().slice(0, 10);

  if (!code) return NextResponse.json({ ok: false, error: "Akun wajib dipilih" }, { status: 400 });

  const db = createAdminClient();

  const { data: account, error: acctErr } = await db
    .from("accounts")
    .select("id, code, name, type, normal_balance")
    .eq("code", code)
    .maybeSingle();
  if (acctErr) return NextResponse.json({ ok: false, error: acctErr.message }, { status: 500 });
  if (!account) return NextResponse.json({ ok: false, error: "Akun tidak ditemukan" }, { status: 404 });

  const sign = account.normal_balance === "Debit" ? 1 : -1;

  // Opening balance = net of every line dated before `from`.
  let opening = 0;
  if (from) {
    const { data: prior, error: priorErr } = await db
      .from("journal_lines")
      .select("debit, credit, journals!inner(date)")
      .eq("account_id", account.id)
      .lt("journals.date", from)
      .limit(10000);
    if (priorErr) return NextResponse.json({ ok: false, error: priorErr.message }, { status: 500 });
    opening = ((prior ?? []) as unknown as RawLine[]).reduce(
      (s, l) => s + sign * (l.debit - l.credit),
      0,
    );
  }

  const { data, error } = await db
    .from("journal_lines")
    .select("debit, credit, journals!inner(reference, description, date)")
    .eq("account_id", account.id)
    .lte("journals.date", to)
    .gte("journals.date", from ?? "0001-01-01")
    .limit(10000);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const lines = ((data ?? []) as unknown as RawLine[])
    .filter((l) => l.journals)
    .sort((a, b) => {
      const j = a.journals as NonNullable<RawLine["journals"]>;
      const k = b.journals as NonNullable<RawLine["journals"]>;
      return j.date === k.date ? j.reference.localeCompare(k.reference) : j.date.localeCompare(k.date);
    });

  let running = opening;
  const rows = lines.map((l) => {
    running += sign * (l.debit - l.credit);
    const j = l.journals as NonNullable<RawLine["journals"]>;
    return {
      reference: j.reference,
      description: j.description,
      date: j.date,
      debit: l.debit,
      credit: l.credit,
      balance: running,
    };
  });

  return NextResponse.json({
    ok: true,
    data: { account: { code: account.code, name: account.name, type: account.type }, opening, rows, closing: running },
  });
}
