import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!isOwner(session.role)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
  const pageSize = 20;

  const db = createAdminClient();

  type JournalRow = {
    id: string;
    reference: string;
    description: string;
    date: string;
    source_type: string | null;
    notes: string | null;
    created_at: string;
  };

  // notes column added in migration 057; cast needed until generated types are regenerated
  // biome-ignore lint/suspicious/noExplicitAny: see above
  let query = (db.from("journals") as any)
    .select("id, reference, description, date, source_type, notes, created_at", { count: "exact" })
    .order("date", { ascending: false })
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  if (from) query = query.gte("date", from);
  if (to) query = query.lte("date", to);

  const { data: journals, count, error } = (await query) as {
    data: JournalRow[] | null;
    count: number | null;
    error: { message: string } | null;
  };
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Load lines for each journal on this page
  const journalIds = (journals ?? []).map((j) => j.id);
  let lines: {
    journal_id: string;
    debit: number;
    credit: number;
    account: { code: string; name: string } | null;
  }[] = [];

  if (journalIds.length > 0) {
    const { data } = await db
      .from("journal_lines")
      .select("journal_id, debit, credit, account:accounts(code, name)")
      .in("journal_id", journalIds);
    lines = (data ?? []) as typeof lines;
  }

  // Group lines by journal_id
  const linesByJournal: Record<string, typeof lines> = {};
  for (const line of lines) {
    if (!linesByJournal[line.journal_id]) linesByJournal[line.journal_id] = [];
    linesByJournal[line.journal_id].push(line);
  }

  const result = (journals ?? []).map((j) => ({
    ...j,
    lines: linesByJournal[j.id] ?? [],
  }));

  return NextResponse.json({
    ok: true,
    data: result,
    total: count ?? 0,
    page,
    pageSize,
  });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!isOwner(session.role)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const db = createAdminClient();
  const { error } = await db.from("journals").delete().eq("id", id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

interface ManualLineInput {
  accountCode: string;
  debit: number;
  credit: number;
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!isOwner(session.role)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  let body: { date?: unknown; description?: unknown; lines?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const date = typeof body.date === "string" ? body.date.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ ok: false, error: "Tanggal tidak valid" }, { status: 400 });
  }
  if (!description) {
    return NextResponse.json({ ok: false, error: "Deskripsi wajib diisi" }, { status: 400 });
  }
  if (!Array.isArray(body.lines) || body.lines.length < 2) {
    return NextResponse.json({ ok: false, error: "Minimal 2 baris jurnal" }, { status: 400 });
  }

  const lines: ManualLineInput[] = [];
  for (const raw of body.lines) {
    const accountCode = typeof raw?.accountCode === "string" ? raw.accountCode.trim() : "";
    const debit = Number(raw?.debit ?? 0);
    const credit = Number(raw?.credit ?? 0);
    if (!accountCode) {
      return NextResponse.json({ ok: false, error: "Setiap baris harus punya akun" }, { status: 400 });
    }
    if (!Number.isInteger(debit) || !Number.isInteger(credit) || debit < 0 || credit < 0) {
      return NextResponse.json({ ok: false, error: "Nominal harus bilangan bulat ≥ 0" }, { status: 400 });
    }
    if ((debit > 0) === (credit > 0)) {
      return NextResponse.json(
        { ok: false, error: "Tiap baris harus debit ATAU kredit, bukan keduanya" },
        { status: 400 },
      );
    }
    lines.push({ accountCode, debit, credit });
  }

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  if (totalDebit === 0) {
    return NextResponse.json({ ok: false, error: "Total tidak boleh nol" }, { status: 400 });
  }
  if (totalDebit !== totalCredit) {
    return NextResponse.json({ ok: false, error: "Debit dan kredit harus seimbang" }, { status: 400 });
  }

  const db = createAdminClient();

  // Resolve account codes → IDs
  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const { data: accounts, error: acctErr } = await db
    .from("accounts")
    .select("id, code")
    .in("code", codes);
  if (acctErr) return NextResponse.json({ ok: false, error: acctErr.message }, { status: 500 });

  const codeToId = Object.fromEntries((accounts ?? []).map((a) => [a.code, a.id]));
  for (const code of codes) {
    if (!codeToId[code]) {
      return NextResponse.json({ ok: false, error: `Akun tidak dikenal: ${code}` }, { status: 400 });
    }
  }

  // Generate reference atomically
  const year = Number(date.slice(0, 4));
  const { data: ref, error: refErr } = await db.rpc("next_journal_reference", { p_year: year });
  if (refErr || !ref) {
    return NextResponse.json({ ok: false, error: "Gagal membuat nomor referensi" }, { status: 500 });
  }

  const { data: journal, error: journalErr } = await db
    .from("journals")
    .insert({
      reference: ref as string,
      description,
      date,
      source_type: "manual",
      source_id: null,
    })
    .select("id, reference")
    .single();
  if (journalErr || !journal) {
    return NextResponse.json({ ok: false, error: journalErr?.message ?? "Gagal menyimpan jurnal" }, { status: 500 });
  }

  const { error: linesErr } = await db.from("journal_lines").insert(
    lines.map((l) => ({
      journal_id: journal.id,
      account_id: codeToId[l.accountCode],
      debit: l.debit,
      credit: l.credit,
    })),
  );
  if (linesErr) {
    await db.from("journals").delete().eq("id", journal.id);
    return NextResponse.json({ ok: false, error: linesErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, data: { id: journal.id, reference: journal.reference } });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!isOwner(session.role)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  let body: { id?: unknown; date?: unknown; description?: unknown; notes?: unknown; lines?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const date = typeof body.date === "string" ? body.date.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes.trim() || null : null;

  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ ok: false, error: "Tanggal tidak valid" }, { status: 400 });
  }
  if (!description) {
    return NextResponse.json({ ok: false, error: "Deskripsi wajib diisi" }, { status: 400 });
  }
  if (!Array.isArray(body.lines) || body.lines.length < 2) {
    return NextResponse.json({ ok: false, error: "Minimal 2 baris jurnal" }, { status: 400 });
  }

  const lines: ManualLineInput[] = [];
  for (const raw of body.lines) {
    const accountCode = typeof raw?.accountCode === "string" ? raw.accountCode.trim() : "";
    const debit = Number(raw?.debit ?? 0);
    const credit = Number(raw?.credit ?? 0);
    if (!accountCode) {
      return NextResponse.json({ ok: false, error: "Setiap baris harus punya akun" }, { status: 400 });
    }
    if (!Number.isInteger(debit) || !Number.isInteger(credit) || debit < 0 || credit < 0) {
      return NextResponse.json({ ok: false, error: "Nominal harus bilangan bulat ≥ 0" }, { status: 400 });
    }
    if ((debit > 0) === (credit > 0)) {
      return NextResponse.json(
        { ok: false, error: "Tiap baris harus debit ATAU kredit, bukan keduanya" },
        { status: 400 },
      );
    }
    lines.push({ accountCode, debit, credit });
  }

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  if (totalDebit === 0 || totalDebit !== totalCredit) {
    return NextResponse.json({ ok: false, error: "Debit dan kredit harus seimbang" }, { status: 400 });
  }

  const db = createAdminClient();

  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const { data: accounts, error: acctErr } = await db.from("accounts").select("id, code").in("code", codes);
  if (acctErr) return NextResponse.json({ ok: false, error: acctErr.message }, { status: 500 });

  const codeToId = Object.fromEntries((accounts ?? []).map((a) => [a.code, a.id]));
  for (const code of codes) {
    if (!codeToId[code]) {
      return NextResponse.json({ ok: false, error: `Akun tidak dikenal: ${code}` }, { status: 400 });
    }
  }

  // Update header (cast: notes not yet in generated types, migration 057)
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const { error: updateErr } = await (db.from("journals") as any)
    .update({ description, date, notes })
    .eq("id", id);
  if (updateErr) return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });

  // Replace lines
  const { error: deleteErr } = await db.from("journal_lines").delete().eq("journal_id", id);
  if (deleteErr) return NextResponse.json({ ok: false, error: deleteErr.message }, { status: 500 });

  const { error: linesErr } = await db.from("journal_lines").insert(
    lines.map((l) => ({
      journal_id: id,
      account_id: codeToId[l.accountCode],
      debit: l.debit,
      credit: l.credit,
    })),
  );
  if (linesErr) return NextResponse.json({ ok: false, error: linesErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
