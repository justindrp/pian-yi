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

  let query = db
    .from("journals")
    .select("id, reference, description, date, source_type, created_at", { count: "exact" })
    .order("date", { ascending: false })
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);

  if (from) query = query.gte("date", from);
  if (to) query = query.lte("date", to);

  const { data: journals, count, error } = await query;
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
