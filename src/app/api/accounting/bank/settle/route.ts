import { type NextRequest, NextResponse } from "next/server";
import { settleBankLines } from "@/lib/accounting/settle-bank-lines";
import { logEdit } from "@/lib/audit/log-edit";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const dynamic = "force-dynamic";

/**
 * Posts kitchen payments to the ledger from the bank lines that prove them.
 * The rules — which contra accounts may settle, and where the books start —
 * live in `settleBankLines`, so a backfill script and this button cannot drift
 * apart on what counts as a settleable line.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  if (!isOwner(session.role))
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as {
    ids?: string[];
  } | null;
  const ids = [...new Set(body?.ids ?? [])].filter(
    (id) => typeof id === "string",
  );
  if (ids.length === 0)
    return NextResponse.json(
      { ok: false, error: "Tidak ada transaksi yang dipilih" },
      { status: 400 },
    );

  const db = createAdminClient();
  const result = await settleBankLines(db, ids, session.email);
  if ("error" in result)
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 500 },
    );

  if (result.posted > 0) {
    await logEdit({
      db,
      actor: session.email,
      entityType: "journals",
      entityId: "bank_settlement",
      action: "settle_bank_lines",
      changes: { posted: result.posted, amount: result.amount, ids },
    });
  }

  return NextResponse.json({ ok: true, data: result });
}
