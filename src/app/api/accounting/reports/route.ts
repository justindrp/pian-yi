import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const dynamic = "force-dynamic";

interface RawLine {
  debit: number;
  credit: number;
  account: { code: string; name: string; type: string; normal_balance: string } | null;
}

interface Tally {
  code: string;
  name: string;
  type: string;
  normal_balance: string;
  debit: number;
  credit: number;
}

// Fetch journal lines joined to their account + journal date, filtered by date range.
// `from` omitted => from the beginning of time (used for cumulative balance-sheet figures).
async function fetchTallies(
  db: ReturnType<typeof createAdminClient>,
  from: string | null,
  to: string,
): Promise<Tally[] | { error: string }> {
  let query = db
    .from("journal_lines")
    .select("debit, credit, account:accounts!inner(code, name, type, normal_balance), journals!inner(date)")
    .lte("journals.date", to)
    .limit(10000);
  if (from) query = query.gte("journals.date", from);

  const { data, error } = await query;
  if (error) return { error: error.message };

  const byCode = new Map<string, Tally>();
  for (const line of (data ?? []) as unknown as RawLine[]) {
    const a = line.account;
    if (!a) continue;
    const t = byCode.get(a.code) ?? {
      code: a.code,
      name: a.name,
      type: a.type,
      normal_balance: a.normal_balance,
      debit: 0,
      credit: 0,
    };
    t.debit += line.debit;
    t.credit += line.credit;
    byCode.set(a.code, t);
  }

  return [...byCode.values()].sort((x, y) => x.code.localeCompare(y.code));
}

// Net balance on the account's normal side (signed). Debit-normal: debit−credit.
function netOnNormalSide(t: Tally): number {
  return t.normal_balance === "Debit" ? t.debit - t.credit : t.credit - t.debit;
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!isOwner(session.role)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "";
  const from = searchParams.get("from");
  const to = searchParams.get("to") ?? new Date().toISOString().slice(0, 10);

  const db = createAdminClient();

  if (type === "trial_balance") {
    const tallies = await fetchTallies(db, from, to);
    if ("error" in tallies) return NextResponse.json({ ok: false, error: tallies.error }, { status: 500 });

    const rows = tallies
      .map((t) => {
        const net = t.debit - t.credit;
        return {
          code: t.code,
          name: t.name,
          type: t.type,
          debit: net > 0 ? net : 0,
          credit: net < 0 ? -net : 0,
        };
      })
      .filter((r) => r.debit !== 0 || r.credit !== 0);

    const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
    const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
    return NextResponse.json({ ok: true, data: { rows, totalDebit, totalCredit } });
  }

  if (type === "pnl") {
    const tallies = await fetchTallies(db, from, to);
    if ("error" in tallies) return NextResponse.json({ ok: false, error: tallies.error }, { status: 500 });

    const revenue = tallies
      .filter((t) => t.type === "Revenue")
      .map((t) => ({ code: t.code, name: t.name, amount: netOnNormalSide(t) }));
    const expense = tallies
      .filter((t) => t.type === "Expense")
      .map((t) => ({ code: t.code, name: t.name, amount: netOnNormalSide(t) }));

    const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
    const totalExpense = expense.reduce((s, r) => s + r.amount, 0);
    return NextResponse.json({
      ok: true,
      data: { revenue, expense, totalRevenue, totalExpense, netIncome: totalRevenue - totalExpense },
    });
  }

  if (type === "balance_sheet") {
    // Cumulative through `to`; ignore `from` so figures are point-in-time balances.
    const tallies = await fetchTallies(db, null, to);
    if ("error" in tallies) return NextResponse.json({ ok: false, error: tallies.error }, { status: 500 });

    const pick = (accType: string) =>
      tallies
        .filter((t) => t.type === accType)
        .map((t) => ({ code: t.code, name: t.name, amount: netOnNormalSide(t) }))
        .filter((r) => r.amount !== 0);

    const assets = pick("Asset");
    const liabilities = pick("Liability");
    const equity = pick("Equity");

    // Retained + current earnings = cumulative revenue − expense, folded into equity.
    const netEarnings = tallies.reduce((s, t) => {
      if (t.type === "Revenue") return s + (t.credit - t.debit);
      if (t.type === "Expense") return s - (t.debit - t.credit);
      return s;
    }, 0);
    if (netEarnings !== 0) {
      equity.push({ code: "—", name: "Laba ditahan & berjalan", amount: netEarnings });
    }

    const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
    const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
    const totalEquity = equity.reduce((s, r) => s + r.amount, 0);
    return NextResponse.json({
      ok: true,
      data: {
        assets,
        liabilities,
        equity,
        totalAssets,
        totalLiabilities,
        totalEquity,
        balanced: totalAssets === totalLiabilities + totalEquity,
      },
    });
  }

  return NextResponse.json({ ok: false, error: "Tipe laporan tidak valid" }, { status: 400 });
}
