import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const dynamic = "force-dynamic";

/**
 * The statements we hold, newest period first, each with the counts the
 * reconcile view needs to say how much of it has been dealt with.
 */
export async function GET(): Promise<Response> {
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

  const db = createAdminClient();

  const { data: statements, error } = await db
    .from("bank_statements")
    .select(
      "id, account_code, account_number, account_label, currency, period_start, period_end, opening_balance, closing_balance, total_credit, total_debit, credit_count, debit_count, source, file_path",
    )
    .order("period_start", { ascending: false })
    .order("account_number", { ascending: true })
    .order("currency", { ascending: true });
  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  // Counting in the browser would need every line of every statement, which is
  // the fixed-window mistake CLAUDE.md names. One grouped pass instead.
  const ids = (statements ?? []).map((s) => s.id);
  const tally = new Map<string, { lines: number; unclassified: number }>();
  if (ids.length > 0) {
    const { data: lines, error: lineErr } = await db
      .from("bank_transactions")
      .select("statement_id, contra_account_code")
      .in("statement_id", ids);
    if (lineErr)
      return NextResponse.json(
        { ok: false, error: lineErr.message },
        { status: 500 },
      );
    for (const l of lines ?? []) {
      const t = tally.get(l.statement_id) ?? { lines: 0, unclassified: 0 };
      t.lines++;
      if (!l.contra_account_code) t.unclassified++;
      tally.set(l.statement_id, t);
    }
  }

  return NextResponse.json({
    ok: true,
    data: (statements ?? []).map((s) => ({
      ...s,
      line_count: tally.get(s.id)?.lines ?? 0,
      unclassified_count: tally.get(s.id)?.unclassified ?? 0,
    })),
  });
}
