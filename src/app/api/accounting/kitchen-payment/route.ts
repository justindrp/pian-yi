import { type NextRequest, NextResponse } from "next/server";
import { recordKitchenPayment } from "@/lib/accounting/kitchen-payment";
import { logEdit } from "@/lib/audit/log-edit";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const dynamic = "force-dynamic";

/**
 * Books a kitchen payment on the day it is made, before the statement that
 * proves it exists. The statement links to this journal when it lands rather
 * than posting a second one — the rule lives in `settleBankLines`.
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
    date?: string;
    amount?: number;
    bankAccountCode?: string;
    subcontractorId?: string | null;
    note?: string | null;
  } | null;

  if (!body?.date || !body.bankAccountCode)
    return NextResponse.json(
      { ok: false, error: "Tanggal dan sumber dana wajib diisi" },
      { status: 400 },
    );

  const db = createAdminClient();
  const res = await recordKitchenPayment(db, {
    date: body.date,
    amount: Number(body.amount),
    bankAccountCode: body.bankAccountCode,
    subcontractorId: body.subcontractorId ?? null,
    note: body.note ?? null,
  });
  if ("error" in res)
    return NextResponse.json({ ok: false, error: res.error }, { status: 400 });

  await logEdit({
    db,
    actor: session.email,
    entityType: "journals",
    entityId: res.journalId,
    action: "record_kitchen_payment",
    changes: {
      date: body.date,
      amount: Number(body.amount),
      bank: body.bankAccountCode,
      subcontractor_id: body.subcontractorId ?? null,
    },
  });

  return NextResponse.json({ ok: true, data: res });
}
