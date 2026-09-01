import { type NextRequest, NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

export const dynamic = "force-dynamic";

/**
 * Correct which account a bank line faces.
 *
 * `matched_by` is what tells a re-import that a human decided this one, so the
 * parser's rules stop overwriting it. It is set here and nowhere else.
 */
export async function PATCH(
  req: NextRequest,
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
  const body = (await req.json().catch(() => null)) as {
    contra_account_code?: string | null;
    notes?: string | null;
  } | null;
  if (!body)
    return NextResponse.json(
      { ok: false, error: "Body tidak valid" },
      { status: 400 },
    );

  const db = createAdminClient();

  const { data: before, error: readErr } = await db
    .from("bank_transactions")
    .select("id, contra_account_code, notes, description, amount, txn_date")
    .eq("id", id)
    .maybeSingle();
  if (readErr)
    return NextResponse.json(
      { ok: false, error: readErr.message },
      { status: 500 },
    );
  if (!before)
    return NextResponse.json(
      { ok: false, error: "Transaksi tidak ditemukan" },
      { status: 404 },
    );

  // Allowlist, never mass assignment: amount, date and direction are the
  // bank's word and are not editable from here at all.
  const patch: {
    contra_account_code?: string | null;
    matched_by?: string;
    matched_at?: string;
    notes?: string | null;
  } = {};

  if ("contra_account_code" in body) {
    const code = body.contra_account_code?.trim() || null;
    if (code) {
      const { data: account } = await db
        .from("accounts")
        .select("code")
        .eq("code", code)
        .eq("is_active", true)
        .maybeSingle();
      if (!account)
        return NextResponse.json(
          { ok: false, error: `Akun ${code} tidak ada atau non-aktif` },
          { status: 400 },
        );
    }
    patch.contra_account_code = code;
    patch.matched_by = session.email;
    patch.matched_at = new Date().toISOString();
  }

  if ("notes" in body) patch.notes = body.notes?.trim() || null;

  if (Object.keys(patch).length === 0)
    return NextResponse.json(
      { ok: false, error: "Tidak ada yang diubah" },
      { status: 400 },
    );

  const { data: updated, error } = await db
    .from("bank_transactions")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error)
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );

  await logEdit({
    db,
    actor: session.email,
    entityType: "bank_transaction",
    entityId: id,
    action: "update",
    changes: {
      description: before.description,
      txn_date: before.txn_date,
      amount: before.amount,
      from: {
        contra_account_code: before.contra_account_code,
        notes: before.notes,
      },
      to: patch,
    },
  });

  return NextResponse.json({ ok: true, data: updated });
}
