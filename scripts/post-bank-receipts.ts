/**
 * Phase 2 of bank reconciliation: post the money-in lines that no journal knows about.
 *
 * Phase 1 (`link-bank-journals.ts`) writes `journal_id` back onto deposits whose
 * journal already exists. This file posts the remainder — and the whole design
 * is about which lines are *not* in that remainder, because the expensive
 * mistake available here is booking the same money twice.
 *
 * Two different double-counts are possible, and they need different guards:
 *
 *   1. A deposit whose journal exists but was never linked. `mark_paid` posts
 *      `order_payment` from the `orders` table and knows nothing about
 *      `bank_transactions`, so the line still reads `journal_id IS NULL` while
 *      the books already carry it. Phase 1 links the ones it can prove; the
 *      ones it could not prove — the name disagreed, or three identical
 *      deposits sat around one journal — are exactly the lines a naive phase 2
 *      would double-post. So the guard is not "did phase 1 link it" but
 *      "is there any journal this line could plausibly be": same bank account,
 *      same amount, within three days, whatever its source type. A line with a
 *      candidate is reported and left alone, forever if need be. A human can
 *      tell in a second which deposit is JV-2026-506; no rule here can.
 *
 *      The candidate search deliberately includes journals already claimed by
 *      another line, and hand-typed `manual` ones. Carolin's Rp 29.000 was
 *      posted by hand as JV-2026-640 — source type `manual`, no order behind
 *      it — and a guard that only looked at `order_payment` would post it again.
 *
 *   2. An internal transfer, which appears twice in the statements: once as the
 *      debit leaving one account and once as the credit arriving in the other.
 *      Both lines are classified, and posting both books one transfer twice.
 *      Which side is the right one to post depends on which statements exist —
 *      ShopeePay has 108 debit lines against it and no statement of its own, so
 *      posting only the arriving side would lose Rp 151jt of float movement.
 *      That decision belongs with the money-out pass, so bank-to-bank contra
 *      accounts are excluded here rather than guessed at.
 *
 * Unlike `settleBankLines`, there is no `BOOKS_START` cutoff. A kitchen payment
 * before the books began clears a payable that was never accrued, which leaves
 * 2001 a debit reading as the kitchen owing us money. A customer deposit is the
 * opposite shape: it creates a liability that the delivery journals later clear,
 * so posting the full history is correct on its own terms. Until the Dec-2025 to
 * Jun-2026 accrual replay lands, 2100 will carry that whole period as deferred
 * revenue — which is what it in fact is.
 *
 * Dry run by default. `--apply` writes.
 */

import { createClient } from "@supabase/supabase-js";
import { createJournalEntry } from "@/lib/accounting/journal";
import { logEdit } from "@/lib/audit/log-edit";
import type { Database } from "@/types/database";

const ACTOR = "system:bank-receipts-phase2";
const MATCH_WINDOW_DAYS = 3;

// Which contra accounts a credit may be posted to. Bank-to-bank codes
// (1002/1003/1005/1006) are absent on purpose — see the header, trap 2.
const POSTABLE = new Map<string, string>([
  ["2100", "Penerimaan pembayaran pelanggan"],
  ["2002", "Setoran pemilik"],
  ["2003", "Setoran partner"],
  ["1100", "Pelunasan piutang"],
  ["4900", "Pendapatan lain-lain"],
  ["6001", "Refund biaya marketing"],
  ["6003", "Refund biaya telepon/internet"],
]);

const db = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
);

const money = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
const daysApart = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

async function page<T>(run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, label: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await run(from, from + 999);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}

type Bank = {
  id: string;
  txn_date: string;
  amount: number;
  counterparty: string | null;
  description: string;
  contra: string;
  account_code: string;
};

/**
 * Every journal carrying a debit to a bank account, whatever posted it.
 * This is the candidate set a deposit is checked against — see trap 1.
 */
async function bankDebitJournals() {
  const rows = await page<{
    id: string;
    reference: string;
    date: string;
    source_type: string | null;
    journal_lines: Array<{ debit: number; accounts: { code: string } | null }>;
  }>(
    (from, to) =>
      db
        .from("journals")
        .select("id, reference, date, source_type, journal_lines(debit, accounts(code))")
        .range(from, to) as never,
    "journals",
  );
  const out: Array<{ id: string; reference: string; date: string; amount: number; account: string; source: string }> = [];
  for (const j of rows) {
    for (const l of j.journal_lines ?? []) {
      const code = l.accounts?.code ?? "";
      if (l.debit > 0 && /^100[0-9]$/.test(code)) {
        out.push({ id: j.id, reference: j.reference, date: j.date, amount: Math.round(l.debit), account: code, source: j.source_type ?? "?" });
      }
    }
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const raw = await page<{
    id: string; txn_date: string; amount: number; counterparty: string | null;
    description: string; contra_account_code: string | null;
    bank_statements: { account_code: string } | null;
  }>(
    (from, to) =>
      db
        .from("bank_transactions")
        .select("id, txn_date, amount, counterparty, description, contra_account_code, bank_statements(account_code)")
        .eq("direction", "CR")
        .is("journal_id", null)
        .order("txn_date")
        .range(from, to) as never,
    "bank_transactions",
  );

  const lines: Bank[] = raw.map((r) => ({
    id: r.id,
    txn_date: r.txn_date,
    amount: Math.round(Number(r.amount)),
    counterparty: r.counterparty,
    description: r.description,
    contra: r.contra_account_code ?? "",
    account_code: r.bank_statements?.account_code ?? "1002",
  }));

  const journals = await bankDebitJournals();

  const postable: Bank[] = [];
  const held: Array<{ line: Bank; hits: typeof journals }> = [];
  const excluded = new Map<string, { n: number; amount: number }>();

  for (const l of lines) {
    if (!POSTABLE.has(l.contra)) {
      const key = l.contra || "(unclassified)";
      const e = excluded.get(key) ?? { n: 0, amount: 0 };
      excluded.set(key, { n: e.n + 1, amount: e.amount + l.amount });
      continue;
    }
    // Trap 1: any journal this deposit could plausibly already be.
    const hits = journals.filter(
      (j) => j.account === l.account_code && j.amount === l.amount && daysApart(j.date, l.txn_date) <= MATCH_WINDOW_DAYS,
    );
    if (hits.length > 0) held.push({ line: l, hits });
    else postable.push(l);
  }

  const total = (rows: Bank[]) => rows.reduce((s, r) => s + r.amount, 0);

  console.log(`unposted credits          : ${lines.length}  ${money(total(lines))}`);
  console.log(`excluded, not in allowlist: ${[...excluded.values()].reduce((s, e) => s + e.n, 0)}  ${money([...excluded.values()].reduce((s, e) => s + e.amount, 0))}`);
  for (const [code, e] of [...excluded].sort((a, b) => b[1].amount - a[1].amount)) {
    console.log(`    ${code.padEnd(16)} ${String(e.n).padStart(4)} lines  ${money(e.amount).padStart(16)}`);
  }
  console.log(`held, a journal may exist : ${held.length}  ${money(total(held.map((h) => h.line)))}`);
  console.log(`TO POST                   : ${postable.length}  ${money(total(postable))}\n`);

  const byContra = new Map<string, { n: number; amount: number }>();
  const byYm = new Map<string, { n: number; amount: number }>();
  for (const l of postable) {
    const c = byContra.get(l.contra) ?? { n: 0, amount: 0 };
    byContra.set(l.contra, { n: c.n + 1, amount: c.amount + l.amount });
    const k = l.txn_date.slice(0, 7);
    const m = byYm.get(k) ?? { n: 0, amount: 0 };
    byYm.set(k, { n: m.n + 1, amount: m.amount + l.amount });
  }
  console.log("to post, by contra account:");
  for (const [code, v] of [...byContra].sort((a, b) => b[1].amount - a[1].amount)) {
    console.log(`    ${code}  ${POSTABLE.get(code)?.padEnd(32)} ${String(v.n).padStart(4)} lines  ${money(v.amount).padStart(16)}`);
  }
  console.log("\nto post, by month:");
  for (const [k, v] of [...byYm].sort()) {
    console.log(`    ${k}  ${String(v.n).padStart(4)} lines  ${money(v.amount).padStart(16)}`);
  }

  console.log(`\n--- HELD: a journal within ${MATCH_WINDOW_DAYS} days for the same amount (${held.length}) ---`);
  for (const h of held) {
    console.log(
      `  ${h.line.txn_date} ${money(h.line.amount).padStart(14)}  ${(h.line.counterparty ?? "").slice(0, 20).padEnd(20)}` +
        ` -> ${h.hits.map((j) => `${j.reference}(${j.source})`).join(", ")}`,
    );
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to post.");
    return;
  }

  let posted = 0;
  let amount = 0;
  const failed: string[] = [];
  for (const l of postable) {
    const who = l.counterparty?.trim() || l.description.slice(0, 40);
    const res = await createJournalEntry({
      description: `${POSTABLE.get(l.contra)} — ${who}`,
      date: l.txn_date,
      sourceType: "bank_receipt",
      sourceId: l.id,
      notes: l.description,
      lines: [
        { accountCode: l.account_code, debit: l.amount, credit: 0 },
        { accountCode: l.contra, debit: 0, credit: l.amount },
      ],
    });
    if (!res) {
      failed.push(`${l.txn_date} ${money(l.amount)} ${who}`);
      continue;
    }
    await db
      .from("bank_transactions")
      .update({ journal_id: res.id, matched_at: new Date().toISOString(), matched_by: ACTOR })
      .eq("id", l.id)
      .is("journal_id", null);
    if (res.created) {
      posted++;
      amount += l.amount;
      await logEdit({
        db,
        actor: ACTOR,
        entityType: "bank_transaction",
        entityId: l.id,
        action: "post_journal",
        changes: { journal_id: res.id, contra: l.contra, amount: l.amount, txn_date: l.txn_date },
      });
    }
  }
  console.log(`\nposted ${posted} journals, ${money(amount)}.`);
  if (failed.length) {
    console.log(`FAILED ${failed.length}:`);
    for (const f of failed) console.log(`  ${f}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
