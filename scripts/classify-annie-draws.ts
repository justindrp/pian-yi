/**
 * Point every bank line that is Annie's profit share at account 2003.
 *
 * She took her 40% share daily, off that day's gross profit, so the draws are
 * scattered across the statements as small odd transfers to "Angela
 * Octaviani" — 143 of them between Desember 2025 and 3 Juli 2026, in 108
 * distinct amounts. Nothing about a line says which it is; only the
 * counterparty does.
 *
 * A draw is not an expense (migration 103): it debits her current account and
 * is settled against her entitlement at period close. Money she sends back
 * credits the same account, which is why both directions are classified here
 * rather than only the outbound half.
 *
 * A line somebody has already set by hand is left alone and reported, because
 * a human decision outranks a name match — the same rule the importer follows.
 *
 * Usage: pnpm tsx --env-file=.env.local scripts/classify-annie-draws.ts [--apply]
 */
import { createAdminClient } from "../src/lib/supabase/admin";

const ANNIE = /angela\s*octaviani/i;
const ACCOUNT = "2003";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { data: statements, error: stErr } = await db
    .from("bank_statements")
    .select("id, account_number, account_label, period_start")
    .order("period_start");
  if (stErr) throw new Error(stErr.message);
  const byStatement = new Map(
    (statements ?? []).map((s) => [s.id, s] as const),
  );

  const rows: {
    id: string;
    statement_id: string;
    txn_date: string;
    direction: string;
    amount: number;
    counterparty: string | null;
    description: string;
    contra_account_code: string | null;
    matched_by: string | null;
  }[] = [];
  const ids = [...byStatement.keys()];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("bank_transactions")
      .select(
        "id, statement_id, txn_date, direction, amount, counterparty, description, contra_account_code, matched_by",
      )
      .in("statement_id", ids)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }

  const hits = rows.filter((r) =>
    ANNIE.test(`${r.counterparty ?? ""} ${r.description}`),
  );
  const handSet = hits.filter((r) => r.matched_by !== null);
  const todo = hits.filter(
    (r) => r.matched_by === null && r.contra_account_code !== ACCOUNT,
  );

  let out = 0;
  let inn = 0;
  for (const r of hits) {
    if (r.direction === "DB") out += Number(r.amount);
    else inn += Number(r.amount);
  }
  console.log(
    `${hits.length} baris atas nama Annie — keluar Rp ${out.toLocaleString("id-ID")}, masuk Rp ${inn.toLocaleString("id-ID")}, netto ditarik Rp ${(out - inn).toLocaleString("id-ID")}`,
  );

  for (const r of handSet) {
    const s = byStatement.get(r.statement_id);
    console.log(
      `  skip ${r.txn_date} ${r.direction} ${Number(r.amount).toLocaleString("id-ID")} — diubah manual ke ${r.contra_account_code ?? "kosong"} (${s?.account_number})`,
    );
  }

  console.log(`${todo.length} baris akan dipindah ke ${ACCOUNT}`);
  if (!apply) {
    console.log("dry run — jalankan ulang dengan --apply");
    return;
  }

  let done = 0;
  for (const r of todo) {
    const { error } = await db
      .from("bank_transactions")
      .update({
        contra_account_code: ACCOUNT,
        matched_by: "script:classify-annie-draws",
        matched_at: new Date().toISOString(),
      })
      .eq("id", r.id);
    if (error) throw new Error(error.message);
    done++;
  }
  console.log(`${done} baris diperbarui`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  },
);
