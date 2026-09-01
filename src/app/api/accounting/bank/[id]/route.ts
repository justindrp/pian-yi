import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const dynamic = "force-dynamic";

/** One statement and every line on it, in the order the bank printed them. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const { id } = await ctx.params;
  const db = createAdminClient();

  const { data: statement, error } = await db
    .from("bank_statements")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  if (!statement)
    return NextResponse.json(
      { ok: false, error: "Rekening koran tidak ditemukan" },
      { status: 404 },
    );

  const { data: lines, error: lineErr } = await db
    .from("bank_transactions")
    .select("*")
    .eq("statement_id", id)
    .order("row_index", { ascending: true });
  if (lineErr)
    return NextResponse.json(
      { ok: false, error: lineErr.message },
      { status: 500 },
    );

  return NextResponse.json({
    ok: true,
    data: { statement, lines: lines ?? [] },
  });
}
