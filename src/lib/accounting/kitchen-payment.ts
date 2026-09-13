import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createJournalEntry } from "@/lib/accounting/journal";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/**
 * Records a kitchen payment on the day it is made.
 *
 * `settleBankLines` posts a payment from the statement line that proves it,
 * which is the honest order of events — except that a BCA e-statement for
 * September does not exist until October. So a kitchen paid this afternoon
 * would sit unbooked for up to a month, and 2001 would read as money still
 * owed to a kitchen that has already been paid.
 *
 * This is the other entry point: the payment is recorded now, from the person
 * who made it, and the statement catches up later. When it does,
 * `settleBankLines` finds this journal and points the bank line at it rather
 * than posting a second one — see `MATCH_WINDOW_DAYS` there. That linking is
 * what makes a hand-entered payment safe; a plain manual journal (Tambah
 * Jurnal) is not, because nothing would recognise it next month.
 *
 * The amount is what left the bank, not what the kitchen's day cost. A
 * transfer covering three days, or rounded up, is still one payment against
 * one payable account: 2001 is a running balance per kitchen, not an invoice
 * queue.
 */
export type KitchenPaymentInput = {
  date: string; // YYYY-MM-DD, the day the transfer left the bank
  amount: number;
  bankAccountCode: string;
  subcontractorId?: string | null;
  note?: string | null;
};

export async function recordKitchenPayment(
  db: Db,
  input: KitchenPaymentInput,
): Promise<{ journalId: string } | { error: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date))
    return { error: "Tanggal tidak valid" };
  if (!Number.isFinite(input.amount) || input.amount <= 0)
    return { error: "Jumlah harus lebih dari 0" };

  const { data: bank } = await db
    .from("accounts")
    .select("code, name, type")
    .eq("code", input.bankAccountCode)
    .maybeSingle();
  // Only an asset account can be the source of a payment. Crediting anything
  // else here would balance the entry and still describe something that did
  // not happen.
  if (bank?.type?.toLowerCase() !== "asset")
    return { error: "Akun sumber dana tidak valid" };

  let who = "dapur";
  if (input.subcontractorId) {
    const { data: sub } = await db
      .from("subcontractors")
      .select("name, customer_nickname")
      .eq("id", input.subcontractorId)
      .maybeSingle();
    if (sub) who = sub.name ?? sub.customer_nickname ?? who;
  }

  const res = await createJournalEntry({
    description: `Bayar dapur — ${who}`,
    date: input.date,
    sourceType: "kitchen_payment",
    sourceId: randomUUID(),
    notes: input.note ?? `Dicatat sebelum rekening koran terbit, dari ${bank.name}`,
    lines: [
      { accountCode: "2001", debit: input.amount, credit: 0 },
      { accountCode: bank.code, debit: 0, credit: input.amount },
    ],
  });
  if (!res) return { error: "Gagal membuat jurnal" };
  return { journalId: res.id };
}
