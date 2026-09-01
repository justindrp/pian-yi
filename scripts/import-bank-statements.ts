/**
 * Parse bank e-statement PDFs into `bank_statements` + `bank_transactions`.
 *
 * Usage: pnpm tsx --env-file=.env.local scripts/import-bank-statements.ts <file.pdf> [...]
 *
 * Re-running on the same file is safe: the statement is looked up by
 * (account_number, currency, period_start, period_end) and its lines are
 * replaced, so a parser fix can be re-applied without duplicating anything.
 * A statement whose control totals do not tie is refused rather than stored —
 * a half-parsed statement reconciles against nothing and looks like it did.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  type ParsedStatement,
  parseStatementPdf,
} from "../src/lib/accounting/statement-parser";
import { createAdminClient } from "../src/lib/supabase/admin";

async function store(db: ReturnType<typeof createAdminClient>, s: ParsedStatement, file: string) {
  const label = `${s.bank} ${s.accountNumber} ${s.currency} ${s.periodStart}..${s.periodEnd}`;

  if (!s.controlTotalsOk) {
    console.error(`  REFUSED ${label} — control totals do not tie`);
    for (const w of s.warnings) console.error(`    ${w}`);
    return false;
  }

  const row = {
    account_code: s.bankAccountCode,
    account_number: s.accountNumber,
    account_label: s.accountLabel,
    currency: s.currency,
    period_start: s.periodStart,
    period_end: s.periodEnd,
    opening_balance: s.openingBalance,
    closing_balance: s.closingBalance,
    total_credit: s.totalCredit,
    total_debit: s.totalDebit,
    credit_count: s.creditCount,
    debit_count: s.debitCount,
    source: "estatement" as const,
    file_path: basename(file),
    file_type: "application/pdf",
    uploaded_by: "script:import-bank-statements",
  };

  const { data: existing } = await db
    .from("bank_statements")
    .select("id")
    .eq("account_number", s.accountNumber)
    .eq("currency", s.currency)
    .eq("period_start", s.periodStart)
    .eq("period_end", s.periodEnd)
    .eq("source", "estatement")
    .maybeSingle();

  let statementId: string;
  if (existing) {
    statementId = existing.id;
    const { error } = await db
      .from("bank_statements")
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq("id", statementId);
    if (error) throw new Error(`update statement: ${error.message}`);
    // Lines are rebuilt from the parse. Any hand-set contra account is kept
    // below, keyed on row_index, because the parse cannot know it.
  } else {
    const { data, error } = await db
      .from("bank_statements")
      .insert(row)
      .select("id")
      .single();
    if (error) throw new Error(`insert statement: ${error.message}`);
    statementId = data.id;
  }

  // A hand correction outranks the parser's guess on a re-import.
  const { data: prior } = await db
    .from("bank_transactions")
    .select("row_index, contra_account_code, journal_id, matched_at, matched_by, notes")
    .eq("statement_id", statementId);
  const kept = new Map((prior ?? []).map((p) => [p.row_index, p]));

  await db.from("bank_transactions").delete().eq("statement_id", statementId);

  const txns = s.lines.map((l) => {
    const p = kept.get(l.rowIndex);
    return {
      statement_id: statementId,
      row_index: l.rowIndex,
      txn_date: l.txnDate,
      txn_time: l.txnTime,
      direction: l.direction,
      amount: l.amount,
      balance_after: l.balanceAfter,
      counterparty: l.counterparty,
      description: l.description,
      raw_text: l.rawText,
      contra_account_code: p?.matched_by ? p.contra_account_code : l.contraAccountCode,
      journal_id: p?.journal_id ?? null,
      matched_at: p?.matched_at ?? null,
      matched_by: p?.matched_by ?? null,
      notes: p?.notes ?? null,
    };
  });

  for (let i = 0; i < txns.length; i += 500) {
    const { error } = await db.from("bank_transactions").insert(txns.slice(i, i + 500));
    if (error) throw new Error(`insert transactions: ${error.message}`);
  }

  const unclassified = s.lines.filter((l) => !l.contraAccountCode).length;
  console.log(
    `  ${existing ? "updated" : "stored"} ${label} — ${s.lines.length} lines, ${unclassified} unclassified`,
  );
  return true;
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: import-bank-statements.ts <file.pdf> [...]");
    process.exit(1);
  }

  const db = createAdminClient();
  let ok = 0;
  let failed = 0;

  for (const file of files) {
    console.log(basename(file));
    try {
      const statements = await parseStatementPdf(new Uint8Array(await readFile(file)));
      for (const s of statements) {
        if (await store(db, s, file)) ok++;
        else failed++;
      }
    } catch (e) {
      console.error(`  FAILED ${basename(file)}: ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  }

  console.log(`\n${ok} stored, ${failed} refused`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
