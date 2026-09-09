/**
 * Annie's Superbank, 1–3 Juli 2026, typed in from two app screenshots.
 *
 * There is no e-statement for this month and there never will be one worth
 * having: her last transaction on the account was 3 Juli, and Superbank does
 * not publish a month's PDF until the 1st of the following month, by which
 * time the kitchen payments had moved to Agnes's account. The screenshots are
 * the complete record of the month, which is what `source = 'screenshot'`
 * exists for.
 *
 * Complete, and provably so: the main account opens at Juni's closing balance
 * of 312.354,43, and the eight lines below land it on 0,43 — the sweep on
 * 3 Juli emptied it. The pocket opens at 5.637,23 and closes at 34.991,23,
 * which is the balance the app showed when the screenshot was taken. Both
 * sides tie to the sen, so no row is missing above or below the fold.
 *
 * Usage: pnpm tsx --env-file=.env.local scripts/import-annie-july-2026.ts [--apply]
 */
import { createAdminClient } from "../src/lib/supabase/admin";

type Line = {
  date: string;
  time: string;
  dir: "CR" | "DB";
  amount: number;
  who: string;
  contra: string | null;
};

type Screenshot = {
  accountNumber: string;
  accountLabel: string;
  opening: number;
  closing: number;
  file: string;
  lines: Line[];
};

// `balance_after` is left null on every line: the app's history list does not
// print a running balance, and inventing one would put a figure in the column
// the bank never said. The Rekening Koran table carries it forward from the
// opening balance instead.
const SHOTS: Screenshot[] = [
  {
    accountNumber: "000076157940",
    accountLabel: "Tabungan Utama — ANGELA OCTAVIANI",
    opening: 312354.43,
    closing: 0.43,
    file: "superbank-annie-2026-07-tabungan-utama.png",
    lines: [
      // Justin funding the account from BCA, as he does every few days.
      { date: "2026-07-01", time: "19:06", dir: "CR", amount: 1500000, who: "Daniel Rahardyan Pramadyo", contra: "1002" },
      { date: "2026-07-01", time: "19:07", dir: "DB", amount: 321000, who: "R Bg Andreas Kurnianto", contra: "2001" },
      { date: "2026-07-01", time: "20:39", dir: "DB", amount: 42500, who: "Angela Octaviani", contra: null },
      // Her own pattern: the purchase, then a matching top-up six hours later.
      // Neither leg is classified here — whether they net to nothing is the
      // reconcile queue's question, not the importer's.
      { date: "2026-07-02", time: "16:33", dir: "DB", amount: 76220, who: "SHIRO MILK-HO", contra: null },
      { date: "2026-07-02", time: "19:02", dir: "DB", amount: 423000, who: "R Bg Andreas Kurnianto", contra: "2001" },
      { date: "2026-07-02", time: "22:34", dir: "CR", amount: 76220, who: "ANGELA OCTAVIANI", contra: null },
      { date: "2026-07-02", time: "22:37", dir: "DB", amount: 42500, who: "Angela Octaviani", contra: null },
      // The sweep into the pocket. Both sides of it are account 1003.
      { date: "2026-07-03", time: "00:41", dir: "DB", amount: 983354, who: "Catering PianYi", contra: "1003" },
    ],
  },
  {
    accountNumber: "000076157940000",
    accountLabel: "Saku Catering PianYi — ANGELA OCTAVIANI",
    opening: 5637.23,
    closing: 34991.23,
    file: "superbank-annie-2026-07-saku-catering.png",
    lines: [
      { date: "2026-07-03", time: "00:41", dir: "CR", amount: 983354, who: "Tabungan Utama", contra: "1003" },
      { date: "2026-07-03", time: "13:08", dir: "DB", amount: 735000, who: "Catering Santapin", contra: "2001" },
      { date: "2026-07-03", time: "15:35", dir: "DB", amount: 219000, who: "Lili Anggraini Se", contra: "2001" },
    ],
  },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  for (const s of SHOTS) {
    const credit = s.lines.filter((l) => l.dir === "CR");
    const debit = s.lines.filter((l) => l.dir === "DB");
    const totalCredit = credit.reduce((a, l) => a + l.amount, 0);
    const totalDebit = debit.reduce((a, l) => a + l.amount, 0);
    const ends = Math.round((s.opening + totalCredit - totalDebit) * 100) / 100;

    console.log(`\n${s.accountNumber} ${s.accountLabel}`);
    console.log(
      `  ${s.opening} + ${totalCredit} - ${totalDebit} = ${ends} (stated ${s.closing})`,
    );
    // A screenshot carries no control totals of its own, so the closing
    // balance is the only check there is — and it is a real one, because it
    // catches a row hidden above or below the fold.
    if (ends !== s.closing) {
      console.error("  REFUSED — does not tie to the closing balance");
      process.exitCode = 1;
      continue;
    }

    const row = {
      account_code: "1003",
      account_number: s.accountNumber,
      account_label: s.accountLabel,
      currency: "IDR",
      period_start: "2026-07-01",
      period_end: "2026-07-03",
      opening_balance: s.opening,
      closing_balance: s.closing,
      total_credit: totalCredit,
      total_debit: totalDebit,
      credit_count: credit.length,
      debit_count: debit.length,
      source: "screenshot" as const,
      file_path: s.file,
      file_type: "image/png",
      uploaded_by: "script:import-annie-july-2026",
      notes:
        "Diketik dari screenshot aplikasi Superbank (1–3 Juli 2026). Tidak ada e-statement: transaksi terakhir 3 Juli, sedangkan PDF baru terbit 1 Agustus. Tertutup terhadap saldo akhir, jadi tidak ada baris yang hilang.",
    };

    if (!apply) {
      console.log(`  would store ${s.lines.length} lines`);
      continue;
    }

    const { data: existing } = await db
      .from("bank_statements")
      .select("id")
      .eq("account_number", s.accountNumber)
      .eq("currency", "IDR")
      .eq("period_start", "2026-07-01")
      .eq("period_end", "2026-07-03")
      .eq("source", "screenshot")
      .maybeSingle();

    let id: string;
    if (existing) {
      id = existing.id;
      const { error } = await db
        .from("bank_statements")
        .update({ ...row, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new Error(error.message);
      await db.from("bank_transactions").delete().eq("statement_id", id);
    } else {
      const { data, error } = await db
        .from("bank_statements")
        .insert(row)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      id = data.id;
    }

    const txns = s.lines.map((l, i) => ({
      statement_id: id,
      row_index: i,
      txn_date: l.date,
      txn_time: l.time,
      direction: l.dir,
      amount: l.amount,
      balance_after: null,
      counterparty: l.who,
      description: `Transfer ${l.dir === "CR" ? "dari" : "ke"} ${l.who}`,
      raw_text: `${l.date} ${l.time} WIB ${l.dir === "CR" ? "+" : "-"}Rp${l.amount} ${l.who}`,
      contra_account_code: l.contra,
    }));
    const { error: insErr } = await db.from("bank_transactions").insert(txns);
    if (insErr) throw new Error(insErr.message);
    console.log(`  ${existing ? "updated" : "stored"} ${txns.length} lines`);
  }

  if (!apply) console.log("\ndry run — re-run with --apply");
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  },
);
