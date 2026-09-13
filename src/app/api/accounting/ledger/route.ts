import { type NextRequest, NextResponse } from "next/server";
import { paymentProofsByJournal } from "@/lib/accounting/payment-proof";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const dynamic = "force-dynamic";

interface RawLine {
  debit: number;
  credit: number;
  journals: {
    id: string;
    reference: string;
    description: string;
    date: string;
    source_type: string | null;
    source_id: string | null;
  } | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  if (!isOwner(session.role))
    return NextResponse.json(
      { ok: false, error: "Forbidden" },
      { status: 403 },
    );

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("account") ?? "";
  const from = searchParams.get("from");
  const to = searchParams.get("to") ?? new Date().toISOString().slice(0, 10);

  if (!code)
    return NextResponse.json(
      { ok: false, error: "Akun wajib dipilih" },
      { status: 400 },
    );

  const db = createAdminClient();

  const { data: account, error: acctErr } = await db
    .from("accounts")
    .select("id, code, name, type, normal_balance")
    .eq("code", code)
    .maybeSingle();
  if (acctErr)
    return NextResponse.json(
      { ok: false, error: acctErr.message },
      { status: 500 },
    );
  if (!account)
    return NextResponse.json(
      { ok: false, error: "Akun tidak ditemukan" },
      { status: 404 },
    );

  const sign = account.normal_balance === "Debit" ? 1 : -1;

  // Opening balance = net of every line dated before `from`.
  let opening = 0;
  if (from) {
    const { rows: prior, error: priorErr } = await fetchAllRows<{
      debit: number;
      credit: number;
    }>((f, t) =>
      db
        .from("journal_lines")
        .select("debit, credit, journals!inner(date)")
        .eq("account_id", account.id)
        .lt("journals.date", from)
        .order("id", { ascending: true })
        .range(f, t),
    );
    if (priorErr)
      return NextResponse.json({ ok: false, error: priorErr }, { status: 500 });
    opening = prior.reduce((s, l) => s + sign * (l.debit - l.credit), 0);
  }

  // Walked to the end rather than capped. A ledger is the one screen that must
  // be complete: an account whose lines stop at an arbitrary row shows a
  // closing balance that matches nothing, and the missing rows are invisible.
  const { rows: data, error } = await fetchAllRows<RawLine>((f, t) =>
    db
      .from("journal_lines")
      .select(
        "debit, credit, journals!inner(id, reference, description, date, source_type, source_id)",
      )
      .eq("account_id", account.id)
      .lte("journals.date", to)
      .gte("journals.date", from ?? "0001-01-01")
      .order("id", { ascending: true })
      .range(f, t),
  );
  if (error) return NextResponse.json({ ok: false, error }, { status: 500 });

  const lines = data
    .filter((l) => l.journals)
    .sort((a, b) => {
      const j = a.journals as NonNullable<RawLine["journals"]>;
      const k = b.journals as NonNullable<RawLine["journals"]>;
      return j.date === k.date
        ? j.reference.localeCompare(k.reference)
        : j.date.localeCompare(k.date);
    });

  // The other side of each entry, so a ledger row can be opened to see the
  // whole double entry rather than only the half that touches this account.
  // A ledger that shows Rp 145.000 debited to the bank and nothing about what
  // was credited cannot be checked against anything.
  const journalIds = [
    ...new Set(
      lines.map((l) => (l.journals as NonNullable<RawLine["journals"]>).id),
    ),
  ];
  const entriesByJournal = new Map<
    string,
    { code: string; name: string; debit: number; credit: number }[]
  >();
  if (journalIds.length > 0) {
    // Both sides of every entry, so this returns two to four rows per journal
    // id — a page's worth of ids is several pages' worth of lines, and the
    // ones that fall off are counter-entries, which show up as a ledger row
    // that cannot be opened rather than as an error. The ids are chunked too:
    // `.in()` puts every one of them in the URL, and a whole account's ledger
    // is thousands of uuids.
    type Entry = {
      journal_id: string;
      debit: number;
      credit: number;
      accounts: { code: string; name: string } | null;
    };
    const entries: Entry[] = [];
    for (let i = 0; i < journalIds.length; i += 200) {
      const chunk = journalIds.slice(i, i + 200);
      const { rows, error: entryErr } = await fetchAllRows<Entry>((f, t) =>
        db
          .from("journal_lines")
          .select("journal_id, debit, credit, accounts(code, name)")
          .in("journal_id", chunk)
          .order("id", { ascending: true })
          .range(f, t),
      );
      if (entryErr)
        return NextResponse.json(
          { ok: false, error: entryErr },
          { status: 500 },
        );
      entries.push(...rows);
    }
    for (const e of entries) {
      const list = entriesByJournal.get(e.journal_id) ?? [];
      list.push({
        code: e.accounts?.code ?? "",
        name: e.accounts?.name ?? "",
        debit: e.debit,
        credit: e.credit,
      });
      entriesByJournal.set(e.journal_id, list);
    }
  }

  const proofs = await paymentProofsByJournal(
    db,
    lines.map((l) => l.journals as NonNullable<RawLine["journals"]>),
  );

  let running = opening;
  const rows = lines.map((l) => {
    running += sign * (l.debit - l.credit);
    const j = l.journals as NonNullable<RawLine["journals"]>;
    return {
      journalId: j.id,
      reference: j.reference,
      description: j.description,
      date: j.date,
      debit: l.debit,
      credit: l.credit,
      balance: running,
      entries: (entriesByJournal.get(j.id) ?? []).sort(
        (a, b) => b.debit - a.debit || a.code.localeCompare(b.code),
      ),
      proof: proofs.get(j.id) ?? null,
    };
  });

  return NextResponse.json({
    ok: true,
    data: {
      account: { code: account.code, name: account.name, type: account.type },
      opening,
      rows,
      closing: running,
    },
  });
}
