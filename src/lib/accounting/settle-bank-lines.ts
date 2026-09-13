import type { SupabaseClient } from "@supabase/supabase-js";
import { createJournalEntry } from "@/lib/accounting/journal";
import { addDays } from "@/lib/time/jakarta";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/**
 * Journalises kitchen payments from the bank lines that are their evidence.
 *
 * Account 2001 Accounts Payable held 297 credits and no debits at all: every
 * portion cooked accrued what we owe a kitchen, and nothing ever paid it down,
 * so the books said we had never settled with anyone. The money had in fact
 * left — 197 transfers, Rp 37.211.000 — and was sitting in `bank_transactions`
 * with `journal_id` null, which is exactly the state that column was added to
 * name: the money moved and the books do not know it.
 *
 * So a settlement is not typed in. It is posted from the statement line, at
 * the bank's own date and the bank's own amount, and the line then points at
 * the journal it produced. Nothing here can invent a payment that did not
 * happen.
 *
 * Idempotent twice over: `journal_id` is checked before posting, and the
 * journal is keyed on the transaction id, so running it again over a line — or
 * over a whole statement — writes nothing.
 */

// Which contra accounts may be settled from a bank line. Deliberately not
// "any classified line":
//   - 2100 customer payments are already journalised by `mark_paid`, and
//     posting them here would count every deposit twice. `link-bank-journals.ts`
//     exists because those journals were posted without the link written back,
//     and it is that missing link — not a missing journal — that makes an
//     unjournalised 2100 line look unposted.
//   - everything else (courier kasbon 1201, outside delivery 5002, ads 6001,
//     infrastructure 6003) is a real posting we do not have a rule for yet —
//     each needs its own decision about which side it lands on and whether an
//     accrual already exists. Widen this set one account at a time.
const SETTLEABLE = new Set(["2001"]);

// The books start here. 133 kitchen transfers (Rp 16.446.000) predate the
// accounting system and have no accrual to clear — posting them to 2001 would
// leave it a large debit for cost that was never recognised, which reads as
// the kitchens owing us money. They stay as evidence in `bank_transactions`,
// unposted, until someone decides how the pre-system period is opened.
const BOOKS_START = "2026-07-01";

// How far a hand-entered `kitchen_payment` journal may sit from the statement
// line that turns out to be the same payment. The two dates are the same event
// seen twice — the afternoon someone transferred, and the day the bank booked
// it — and they disagree by a day over a weekend or a late-evening transfer.
// Five days is wide enough for that and narrow enough that two payments of the
// identical amount from the identical account would have to fall inside one
// working week to be confusable; the amount and the bank account must match
// exactly, and a journal already pointed at by a bank line is never reused.
const MATCH_WINDOW_DAYS = 5;

function daysApart(a: string, b: string): number {
  return Math.abs(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000,
  );
}

type Candidate = { id: string; date: string; amount: number; accountId: string };

/**
 * Hand-entered kitchen payments that no bank line points at yet.
 *
 * A payment recorded the day it was made (`recordKitchenPayment`) is the same
 * money as the statement line that shows up a month later. Posting the line
 * too would debit 2001 twice and halve the payable — the exact failure
 * `scripts/link-bank-journals.ts` was written to clean up on the customer
 * side. So the line is linked to the journal that already exists instead.
 */
async function unlinkedKitchenPayments(
  db: Db,
  from: string,
  to: string,
): Promise<Candidate[]> {
  const { data: journals } = await db
    .from("journals")
    .select("id, date, journal_lines(account_id, debit, credit)")
    .eq("source_type", "kitchen_payment")
    .gte("date", from)
    .lte("date", to);
  if (!journals?.length) return [];

  const { data: taken } = await db
    .from("bank_transactions")
    .select("journal_id")
    .in(
      "journal_id",
      journals.map((j) => j.id),
    );
  const used = new Set((taken ?? []).map((t) => t.journal_id));

  const out: Candidate[] = [];
  for (const j of journals) {
    if (used.has(j.id)) continue;
    const lines = (j.journal_lines ?? []) as {
      account_id: string;
      debit: number;
      credit: number;
    }[];
    // The credit side is the bank the money left, and its amount is the
    // payment. A journal with more than one credit line is not something this
    // route wrote, so it is left alone.
    const credits = lines.filter((l) => Number(l.credit) > 0);
    if (credits.length !== 1) continue;
    out.push({
      id: j.id,
      date: j.date,
      amount: Number(credits[0].credit),
      accountId: credits[0].account_id,
    });
  }
  return out;
}

export type SettleResult = {
  posted: number;
  linked: number;
  amount: number;
  skipped: { id: string; reason: string }[];
};

export async function settleBankLines(
  db: Db,
  ids: string[],
  actor: string,
): Promise<SettleResult | { error: string }> {
  const { data: txns, error } = await db
    .from("bank_transactions")
    .select(
      "id, statement_id, txn_date, direction, amount, counterparty, description, contra_account_code, journal_id",
    )
    .in("id", ids);
  if (error) return { error: error.message };

  const { data: statements } = await db
    .from("bank_statements")
    .select("id, account_code, currency")
    .in("id", [...new Set((txns ?? []).map((t) => t.statement_id))]);
  const statementById = new Map((statements ?? []).map((s) => [s.id, s]));

  const dates = (txns ?? []).map((t) => t.txn_date).sort();
  const candidates = dates.length
    ? await unlinkedKitchenPayments(
        db,
        addDays(dates[0], -MATCH_WINDOW_DAYS),
        addDays(dates[dates.length - 1], MATCH_WINDOW_DAYS),
      )
    : [];
  const { data: accountRows } = await db.from("accounts").select("id, code");
  const accountIdByCode = new Map(
    (accountRows ?? []).map((a) => [a.code, a.id] as const),
  );

  let posted = 0;
  let linked = 0;
  let amount = 0;
  const skipped: { id: string; reason: string }[] = [];

  for (const txn of txns ?? []) {
    if (txn.journal_id) {
      skipped.push({ id: txn.id, reason: "sudah ada jurnal" });
      continue;
    }
    if (!txn.contra_account_code || !SETTLEABLE.has(txn.contra_account_code)) {
      skipped.push({ id: txn.id, reason: "akun lawan bukan 2001" });
      continue;
    }
    if (txn.txn_date < BOOKS_START) {
      skipped.push({ id: txn.id, reason: `sebelum ${BOOKS_START}` });
      continue;
    }
    const statement = statementById.get(txn.statement_id);
    if (!statement) {
      skipped.push({ id: txn.id, reason: "rekening koran tidak ditemukan" });
      continue;
    }
    // A USD line would need a rate to post in rupiah, and guessing one is how
    // a ledger acquires a number nobody can trace.
    if (statement.currency !== "IDR") {
      skipped.push({ id: txn.id, reason: `mata uang ${statement.currency}` });
      continue;
    }

    const value = Number(txn.amount);
    const who = txn.counterparty ?? txn.description;
    // A debit is money leaving us: the payable comes down and the bank with
    // it. A credit on a payable line is the kitchen sending money back — a
    // refund or an overpayment returned — which puts the debt back up.
    const lines =
      txn.direction === "DB"
        ? [
            { accountCode: "2001", debit: value, credit: 0 },
            { accountCode: statement.account_code, debit: 0, credit: value },
          ]
        : [
            { accountCode: statement.account_code, debit: value, credit: 0 },
            { accountCode: "2001", debit: 0, credit: value },
          ];

    // Already recorded by hand on the day it was paid? Point the line at that
    // journal. Nothing is posted, and the payment counts once.
    const bankAccountId = accountIdByCode.get(statement.account_code);
    const matchIndex =
      txn.direction === "DB" && bankAccountId
        ? candidates.findIndex(
            (c) =>
              c.amount === value &&
              c.accountId === bankAccountId &&
              daysApart(c.date, txn.txn_date) <= MATCH_WINDOW_DAYS,
          )
        : -1;
    if (matchIndex >= 0) {
      const match = candidates.splice(matchIndex, 1)[0];
      await db
        .from("bank_transactions")
        .update({
          journal_id: match.id,
          matched_at: new Date().toISOString(),
          matched_by: actor,
        })
        .eq("id", txn.id);
      linked++;
      continue;
    }

    const res = await createJournalEntry({
      description:
        txn.direction === "DB"
          ? `Bayar dapur — ${who}`
          : `Pengembalian dari dapur — ${who}`,
      date: txn.txn_date,
      sourceType: "bank_settlement",
      sourceId: txn.id,
      notes: txn.description,
      lines,
    });
    if (!res) {
      skipped.push({ id: txn.id, reason: "gagal membuat jurnal" });
      continue;
    }

    // `matched_by` is what stops a re-import's rules from rewriting the contra
    // account. A line with a journal against it must keep the account that
    // journal was posted to, so posting counts as a human decision about it.
    await db
      .from("bank_transactions")
      .update({
        journal_id: res.id,
        matched_at: new Date().toISOString(),
        matched_by: actor,
      })
      .eq("id", txn.id);

    if (res.created) {
      posted++;
      amount += value;
    }
  }

  return { posted, linked, amount, skipped };
}
