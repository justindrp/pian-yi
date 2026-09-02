/**
 * Phase 1 of bank reconciliation: link bank lines to journals that already exist.
 *
 * Nothing is linked without the name agreeing. Uniqueness inside the candidate
 * graph looked like proof and is not: a deposit whose own journal has not been
 * posted yet can still be the only amount-and-date match for somebody else's
 * journal, and a first draft of this script duly offered to file Dessy's
 * Rp 174.000 against Veronica's JV. A forced pairing with a name mismatch is
 * reported for review instead — some of those are real proxy payers, and a
 * person can tell which in a second.
 *
 * The bank statements and the double-entry ledger were built independently and
 * never cross-referenced. `order_payment` journals were posted from the `orders`
 * table, so they know nothing about `bank_transactions`, and every one of those
 * rows still reads `journal_id IS NULL` — "the money moved and the books do not
 * know it", which is false for 31 of them. The books do know; nothing wrote the
 * link back.
 *
 * That makes a naive "post a journal for every unjournalised bank line" script
 * the most expensive mistake available here: it would double-count Rp 14M+ of
 * revenue against journals that are already posted. So linking is its own pass,
 * it runs first, and it creates nothing. Posting the genuinely-missing journals
 * is phase 2 and is deliberately not in this file.
 *
 * Matching is amount + date + name, and the safety comes from insisting on a
 * mutually unique pairing rather than a best guess:
 *
 *   Pass 1  a bank line with exactly one candidate journal, where that journal
 *           has exactly one candidate bank line, and the names agree. Nothing
 *           else can claim either side, so the pairing is forced.
 *   Pass 2  a bank line with several candidates but exactly one whose payer or
 *           beneficiary name shares a token with the bank's counterparty.
 *
 * Everything else is reported and left alone. JV-2026-506 is why: one Rp 540.000
 * journal sits within three days of three separate Rp 540.000 deposits, and no
 * amount-and-date rule can say which deposit it is. A wrong link is worse than
 * no link, because the next pass will believe it.
 *
 * Dry run by default. `--apply` writes.
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logEdit } from "@/lib/audit/log-edit";

const ACTOR = "system:bank-link-phase1";
const DAY_WINDOW = 3;

const db = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
);

const money = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime();
const daysApart = (a: number, b: number) => Math.abs(a - b) / 86_400_000;

/** Tokens worth comparing: a bank counterparty is upper-case and often truncated. */
function tokens(name: string | null | undefined): Set<string> {
  return new Set(
    (name ?? "")
      .toUpperCase()
      .replace(/[^A-Z ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
}

function sharesName(bank: string, order: Array<string | null | undefined>): boolean {
  const b = tokens(bank);
  if (b.size === 0) return false;
  for (const name of order) {
    for (const t of tokens(name)) {
      if (b.has(t)) return true;
      // BCA truncates at 18 characters, so the last token is often a prefix.
      for (const w of b) if (w.length >= 4 && (t.startsWith(w) || w.startsWith(t))) return true;
    }
  }
  return false;
}

type BankRow = {
  id: string;
  txn_date: string;
  amount: number;
  counterparty: string | null;
  description: string;
  account_code: string;
};

type JournalRow = {
  id: string;
  reference: string;
  date: string;
  bankDebit: number;
  bankAccount: string;
  names: Array<string | null>;
};

async function loadBankRows(): Promise<BankRow[]> {
  const { data, error } = await db
    .from("bank_transactions")
    .select("id, txn_date, amount, counterparty, description, statement_id, bank_statements(account_code)")
    .eq("contra_account_code", "2100")
    .eq("direction", "CR")
    .is("journal_id", null)
    .order("txn_date");
  if (error) throw new Error(`bank_transactions: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    txn_date: r.txn_date,
    amount: Number(r.amount),
    counterparty: r.counterparty,
    description: r.description,
    account_code:
      (r.bank_statements as unknown as { account_code: string } | null)?.account_code ?? "1002",
  }));
}

async function loadJournals(): Promise<JournalRow[]> {
  const { data, error } = await db
    .from("journals")
    .select("id, reference, date, source_id, journal_lines(debit, credit, accounts(code))")
    .eq("source_type", "order_payment");
  if (error) throw new Error(`journals: ${error.message}`);

  // Which journals are already spoken for — a journal is evidence for one deposit.
  const { data: taken } = await db.from("bank_transactions").select("journal_id").not("journal_id", "is", null);
  const claimed = new Set((taken ?? []).map((t) => t.journal_id as string));

  const orderIds = (data ?? []).map((j) => j.source_id).filter((v): v is string => Boolean(v));
  const names = new Map<string, Array<string | null>>();
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data: orders } = await db
      .from("orders")
      .select(
        "id, customers!orders_customer_id_fkey(name), payer:customers!orders_paid_by_customer_id_fkey(name)",
      )
      .in("id", orderIds.slice(i, i + 200));
    for (const o of orders ?? []) {
      const eater = (o.customers as unknown as { name: string } | null)?.name ?? null;
      const payer = (o.payer as unknown as { name: string } | null)?.name ?? null;
      names.set(o.id, [eater, payer]);
    }
  }

  const out: JournalRow[] = [];
  for (const j of data ?? []) {
    if (claimed.has(j.id)) continue;
    const lines = (j.journal_lines ?? []) as unknown as Array<{
      debit: number;
      credit: number;
      accounts: { code: string } | null;
    }>;
    // The bank side of an order_payment journal is its only debit to a bank account.
    const bank = lines.find((l) => l.debit > 0 && /^100[0-9]$/.test(l.accounts?.code ?? ""));
    if (!bank) continue;
    out.push({
      id: j.id,
      reference: j.reference,
      date: j.date,
      bankDebit: bank.debit,
      bankAccount: bank.accounts?.code ?? "",
      names: j.source_id ? (names.get(j.source_id) ?? []) : [],
    });
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const bankRows = await loadBankRows();
  const journals = await loadJournals();

  console.log(`unjournalised 2100 credits : ${bankRows.length}`);
  console.log(`unclaimed order_payment JVs: ${journals.length}\n`);

  // Candidate edges: same bank account, same amount, within the date window.
  const candidates = new Map<string, JournalRow[]>();
  const reverse = new Map<string, BankRow[]>();
  for (const b of bankRows) {
    const hits = journals.filter(
      (j) =>
        j.bankAccount === b.account_code &&
        j.bankDebit === Math.round(b.amount) &&
        daysApart(day(b.txn_date), day(j.date)) <= DAY_WINDOW,
    );
    candidates.set(b.id, hits);
    for (const j of hits) reverse.set(j.id, [...(reverse.get(j.id) ?? []), b]);
  }

  const linked: Array<{ bank: BankRow; journal: JournalRow; via: string }> = [];
  const claimed = new Set<string>();

  // Pass 1 — forced pairings: one candidate each way, so nothing else can claim
  // either side. The name still has to agree; see the header for why.
  const review: Array<{ bank: BankRow; journal: JournalRow }> = [];
  for (const b of bankRows) {
    const hits = candidates.get(b.id) ?? [];
    if (hits.length !== 1) continue;
    const j = hits[0];
    if (claimed.has(j.id) || (reverse.get(j.id) ?? []).length !== 1) continue;
    if (!sharesName(b.counterparty ?? b.description, j.names)) {
      review.push({ bank: b, journal: j });
      continue;
    }
    claimed.add(j.id);
    linked.push({ bank: b, journal: j, via: "unique" });
  }

  // Pass 2 — several candidates, exactly one carrying the payer's or eater's name.
  for (const b of bankRows) {
    if (linked.some((l) => l.bank.id === b.id)) continue;
    const hits = (candidates.get(b.id) ?? []).filter((j) => !claimed.has(j.id));
    if (hits.length < 2) continue;
    const named = hits.filter((j) => sharesName(b.counterparty ?? b.description, j.names));
    if (named.length !== 1) continue;
    claimed.add(named[0].id);
    linked.push({ bank: b, journal: named[0], via: "name" });
  }

  const ambiguous = bankRows.filter(
    (b) =>
      !linked.some((l) => l.bank.id === b.id) &&
      !review.some((r) => r.bank.id === b.id) &&
      (candidates.get(b.id) ?? []).length > 0,
  );
  const orphan = bankRows.filter((b) => (candidates.get(b.id) ?? []).length === 0);

  console.log(`--- LINK (${linked.length}, ${money(linked.reduce((s, l) => s + l.bank.amount, 0))}) ---`);
  for (const l of linked) {
    console.log(
      `  ${l.bank.txn_date} ${money(l.bank.amount).padStart(14)}  ${l.journal.reference}  ` +
        `[${l.via}] ${l.bank.counterparty ?? ""} -> ${l.journal.names.filter(Boolean).join(" / ")}`,
    );
  }

  console.log(`\n--- REVIEW: only candidate, but the name disagrees (${review.length}) ---`);
  for (const r of review) {
    console.log(
      `  ${r.bank.txn_date} ${money(r.bank.amount).padStart(14)}  ${r.journal.reference}  ` +
        `${r.bank.counterparty ?? ""} -> ${r.journal.names.filter(Boolean).join(" / ")}`,
    );
  }

  console.log(`\n--- AMBIGUOUS, left alone (${ambiguous.length}) ---`);
  for (const b of ambiguous) {
    const hits = candidates.get(b.id) ?? [];
    console.log(
      `  ${b.txn_date} ${money(b.amount).padStart(14)}  ${b.counterparty ?? ""} ` +
        `-> ${hits.length} candidates: ${hits.map((h) => h.reference).join(", ")}`,
    );
  }

  console.log(`\n--- NO JOURNAL, phase 2 (${orphan.length}, ${money(orphan.reduce((s, b) => s + b.amount, 0))}) ---`);
  for (const b of orphan) {
    console.log(`  ${b.txn_date} ${money(b.amount).padStart(14)}  ${b.counterparty ?? ""}`);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write the links.");
    return;
  }

  let ok = 0;
  for (const l of linked) {
    const { error } = await db
      .from("bank_transactions")
      .update({ journal_id: l.journal.id, matched_at: new Date().toISOString(), matched_by: ACTOR })
      .eq("id", l.bank.id)
      .is("journal_id", null);
    if (error) {
      console.error(`  FAILED ${l.bank.txn_date} ${l.journal.reference}: ${error.message}`);
      continue;
    }
    ok++;
    await logEdit({
      db,
      actor: ACTOR,
      entityType: "bank_transaction",
      entityId: l.bank.id,
      action: "link_journal",
      changes: {
        journal_id: l.journal.id,
        reference: l.journal.reference,
        matched_via: l.via,
        amount: l.bank.amount,
        txn_date: l.bank.txn_date,
      },
    });
  }
  console.log(`\nlinked ${ok}/${linked.length}. No journals created.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
