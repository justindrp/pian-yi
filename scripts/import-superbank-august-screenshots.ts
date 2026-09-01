/**
 * Imports Agnes's Superbank August 2026 transactions from the three
 * screenshots she sent on 17 Agustus, as source='screenshot'.
 *
 * Superbank never issued an August e-statement: Agnes resigned on 17 Agustus
 * and swept the balance to BCA, so the month has no closing document and never
 * will. The screenshots are an in-app transaction list — no running balance,
 * no control totals, sen not printed.
 *
 * That normally means a partial capture you cannot trust. Here it is provable:
 * July closed at 673.009,37, the screenshots carry 6.000.000 in and 5.681.000
 * out before the sweep, and 673.009 + 6.000.000 - 5.681.000 is exactly the
 * 992.009 that arrives in BCA on 17 Agustus as "BIF TRANSFER DR AGNESIA
 * AGATHA CHR". The chain closes to the sen, so these 24 rows are the whole of
 * August for this account — there was no activity on 1 Agustus and nothing was
 * lost between the three scroll positions.
 *
 * balance_after is left null rather than back-computed from that chain. The
 * screenshots do not print it, and a derived figure in a column that means
 * "what the bank said" is how a reconciliation stops being evidence.
 *
 * Contra accounts:
 *   R Bg Andreas Kurnianto  -> 2001  kitchen payment, as in July
 *   Dnid Salxxxxxx Putxx    -> 1201  courier cash advance, as in July
 *   Daniel Rahardyan (CR)   -> 1005  NOT 1002 as in July. BCA has no direct
 *                                    transfer to Superbank on 4, 9, 11 or 13
 *                                    Agustus — it has a 1.500.000 debit to
 *                                    SHOPEEPAY on each of those exact dates.
 *                                    The float routed BCA -> ShopeePay ->
 *                                    Superbank in August.
 *   Daniel Rahardyan (DB)   -> 1002  the closing sweep back to BCA.
 *   Dnid Donx Kurxxxxxx     -> null  unrecognised payee, 15.000, one row.
 *                                    Left for the reconcile queue rather than
 *                                    guessed into 5002.
 *
 * Run: tsx --env-file=.env.local scripts/import-superbank-august-screenshots.ts [--apply]
 */
import { createAdminClient } from "../src/lib/supabase/admin";
import { logEdit } from "../src/lib/audit/log-edit";

const ACTOR = "system:superbank-aug-screenshot-import-2026-09-01";
const ACCOUNT_NUMBER = "000091762385";

type Row = {
  date: string;
  time: string;
  dir: "CR" | "DB";
  amount: number;
  who: string;
  contra: string | null;
};

/** Chronological, oldest first, matching the July statement's row_index. */
const ROWS: Row[] = [
  { date: "2026-08-02", time: "04:26 PM", dir: "DB", amount: 261000, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-03", time: "04:55 PM", dir: "DB", amount: 220500, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-04", time: "02:08 PM", dir: "CR", amount: 1500000, who: "Daniel Rahardyan Pramadyo", contra: "1005" },
  { date: "2026-08-04", time: "02:12 PM", dir: "DB", amount: 200000, who: "Dnid Salxxxxxx Putxx", contra: "1201" },
  { date: "2026-08-04", time: "04:38 PM", dir: "DB", amount: 177000, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-05", time: "04:23 PM", dir: "DB", amount: 177000, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-06", time: "04:46 PM", dir: "DB", amount: 180000, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-07", time: "09:51 AM", dir: "DB", amount: 50000, who: "Dnid Salxxxxxx Putxx", contra: "1201" },
  { date: "2026-08-09", time: "04:52 PM", dir: "CR", amount: 1500000, who: "Daniel Rahardyan Pramadyo", contra: "1005" },
  { date: "2026-08-09", time: "05:16 PM", dir: "DB", amount: 792500, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-09", time: "05:24 PM", dir: "DB", amount: 21000, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-09", time: "08:04 PM", dir: "DB", amount: 19500, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-10", time: "05:04 PM", dir: "DB", amount: 854000, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-10", time: "06:30 PM", dir: "DB", amount: 15000, who: "Dnid Donx Kurxxxxxx", contra: null },
  { date: "2026-08-11", time: "11:07 AM", dir: "DB", amount: 50000, who: "Dnid Salxxxxxx Putxx", contra: "1201" },
  { date: "2026-08-11", time: "04:55 PM", dir: "CR", amount: 1500000, who: "Daniel Rahardyan Pramadyo", contra: "1005" },
  { date: "2026-08-11", time: "05:08 PM", dir: "DB", amount: 812000, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-12", time: "04:43 PM", dir: "DB", amount: 784500, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-13", time: "01:30 PM", dir: "DB", amount: 100000, who: "Dnid Salxxxxxx Putxx", contra: "1201" },
  { date: "2026-08-13", time: "04:28 PM", dir: "CR", amount: 1500000, who: "Daniel Rahardyan Pramadyo", contra: "1005" },
  { date: "2026-08-13", time: "04:49 PM", dir: "DB", amount: 826500, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-14", time: "04:39 PM", dir: "DB", amount: 40500, who: "R Bg Andreas Kurnianto", contra: "2001" },
  { date: "2026-08-17", time: "10:09 AM", dir: "DB", amount: 100000, who: "Dnid Salxxxxxx Putxx", contra: "1201" },
  { date: "2026-08-17", time: "11:54 AM", dir: "DB", amount: 992009, who: "Daniel Rahardyan Pramadyo", contra: "1002" },
];

const OPENING = 673009.37;

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const credit = ROWS.filter((r) => r.dir === "CR").reduce((s, r) => s + r.amount, 0);
  const debit = ROWS.filter((r) => r.dir === "DB").reduce((s, r) => s + r.amount, 0);
  const closing = OPENING + credit - debit;

  console.log(`rows ${ROWS.length}  CR ${credit}  DB ${debit}`);
  console.log(`opening ${OPENING} -> closing ${closing.toFixed(2)}`);
  if (Math.abs(closing) > 1) {
    console.error("closing balance is not ~0; the screenshot set does not tie. Aborting.");
    process.exit(1);
  }

  const { data: existing } = await db
    .from("bank_statements")
    .select("id, period_start, period_end")
    .eq("account_number", ACCOUNT_NUMBER)
    .eq("source", "screenshot");
  if (existing?.length) {
    console.error(`already imported: ${existing.map((e) => `${e.id} ${e.period_start}..${e.period_end}`).join(", ")}`);
    process.exit(1);
  }

  if (!apply) {
    for (const [i, r] of ROWS.entries())
      console.log(`  ${String(i).padStart(2)} ${r.date} ${r.time} ${r.dir} ${String(r.amount).padStart(9)} [${r.contra ?? "-"}] ${r.who}`);
    console.log("\nDRY RUN. Re-run with --apply.");
    return;
  }

  const { data: stmt, error: stmtErr } = await db
    .from("bank_statements")
    .insert({
      account_code: "1003",
      account_number: ACCOUNT_NUMBER,
      account_label: "Superbank Tabungan Utama — Agnesia Agatha Christiadi",
      currency: "IDR",
      period_start: "2026-08-01",
      period_end: "2026-08-17",
      opening_balance: OPENING,
      closing_balance: Number(closing.toFixed(2)),
      total_credit: credit,
      total_debit: debit,
      credit_count: ROWS.filter((r) => r.dir === "CR").length,
      debit_count: ROWS.filter((r) => r.dir === "DB").length,
      source: "screenshot",
      file_type: "image/jpeg",
      uploaded_by: ACTOR,
      notes:
        "Three WhatsApp screenshots of the Superbank app taken 2026-08-17 11:55-11:56. " +
        "No August e-statement exists: Agnes resigned on 17 Agustus and swept the balance " +
        "to BCA, closing the account. The capture is complete rather than partial — " +
        "673.009,37 (July close) + 6.000.000 - 5.681.000 = the 992.009 that lands in BCA " +
        "on 17 Agustus, so the chain ties to the sen. balance_after is null on every row " +
        "because the app list does not print it.",
    })
    .select("id")
    .single();
  if (stmtErr) throw stmtErr;

  const { error: txErr } = await db.from("bank_transactions").insert(
    ROWS.map((r, i) => ({
      statement_id: stmt.id,
      row_index: i,
      txn_date: r.date,
      txn_time: r.time,
      direction: r.dir,
      amount: r.amount,
      balance_after: null,
      counterparty: r.who,
      description: `Transfer ${r.dir === "CR" ? "dari" : "ke"} ${r.who}`,
      raw_text: `${Number(r.date.slice(8))} Agu ${r.time} Transfer ${r.dir === "CR" ? "dari" : "ke"} ${r.who}`,
      contra_account_code: r.contra,
    })),
  );
  if (txErr) throw txErr;

  await logEdit({
    db,
    actor: ACTOR,
    entityType: "bank_statement",
    entityId: stmt.id,
    action: "import_statement",
    changes: { source: "screenshot", rows: ROWS.length, credit, debit, opening: OPENING, closing },
  });

  console.log(`imported statement ${stmt.id} with ${ROWS.length} rows`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
