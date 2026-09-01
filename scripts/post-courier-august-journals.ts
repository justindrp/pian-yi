/**
 * Posts the courier's August 2026 wage cycle to the ledger: the ten cash
 * advances he drew during the month, the wage he earned, the two deductions
 * against it, and the two transfers that settled it on 1 September.
 *
 * Written because 5002, 1201 and 1003 all had zero journal lines. The bank
 * statements were imported and classified but nothing was ever posted, so the
 * ledger showed a business with no delivery cost and a courier who had neither
 * been advanced money nor paid.
 *
 * The scope is one person's month rather than the whole statement, and that
 * leaves a visible edge: crediting 1003 and 1002 for the advances without the
 * matching funding entries makes 1003 read -500.000 until the rest of the
 * Superbank statement is journalised. That is the tracked follow-up, not a
 * defect here — the alternative was to post a settlement that clears a payable
 * nobody accrued and an advance nobody recorded, which is worse than an
 * incomplete bank balance because it cannot be told apart from a real error.
 *
 * The Rp 136.364 is a July deduction — two days he did not deliver, at the
 * daily rate of 3.000.000 / 22 — booked against August because July's courier
 * month was never journalised at all and there is nothing in July to reverse.
 * August's courier cost is therefore Rp 136.364 lighter than the month itself
 * was, and July's is missing entirely.
 *
 * Wages sit in 2001 Accounts Payable with the kitchen's COGS accruals; there
 * is no separate wages-payable account. It nets to nil on 31 Agustus either
 * way, but 2001's balance is not "what we owe the kitchen" while this is open.
 *
 * Run: tsx --env-file=.env.local scripts/post-courier-august-journals.ts [--apply]
 */
import { createAdminClient } from "../src/lib/supabase/admin";
import { logEdit } from "../src/lib/audit/log-edit";

const ACTOR = "system:courier-august-journals-2026-09-01";

const DAILY_RATE = 3000000 / 22; // 136.363,63 — 22 working days
const BASE_WAGE = 3000000;
const JULY_NON_DELIVERY = Math.round(DAILY_RATE); // 136.364, 2 x half-day
const DENDA = 20000; // 10 Agustus, delivered to the wrong address

type Line = { code: string; debit: number; credit: number };
type Entry = { key: string; date: string; description: string; lines: Line[] };

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  // The ten August advances, read from the statements rather than retyped, so
  // an entry can never disagree with the bank line it is posted against.
  const { data: stmts } = await db
    .from("bank_statements")
    .select("id, account_code");
  const stmtAccount = new Map((stmts ?? []).map((s) => [s.id, s.account_code]));

  const { data: advances } = await db
    .from("bank_transactions")
    .select("id, statement_id, txn_date, amount, journal_id")
    .eq("contra_account_code", "1201")
    .gte("txn_date", "2026-08-01")
    .lte("txn_date", "2026-08-31")
    .order("txn_date");

  if (!advances?.length) throw new Error("no August 1201 rows found");
  const already = advances.filter((a) => a.journal_id);
  if (already.length)
    throw new Error(`${already.length} advance rows already journalised`);

  const advanceTotal = advances.reduce((s, a) => s + Number(a.amount), 0);
  const settlement = BASE_WAGE - advanceTotal - JULY_NON_DELIVERY - DENDA;

  const entries: Entry[] = [];

  for (const a of advances) {
    const bank = stmtAccount.get(a.statement_id);
    if (!bank) throw new Error(`no statement for ${a.id}`);
    entries.push({
      key: a.id,
      date: a.txn_date,
      description: `Kasbon kurir ${a.txn_date}`,
      lines: [
        { code: "1201", debit: Number(a.amount), credit: 0 },
        { code: bank, debit: 0, credit: Number(a.amount) },
      ],
    });
  }

  entries.push({
    key: "wage-accrual",
    date: "2026-08-31",
    description: "Gaji kurir Agustus 2026",
    lines: [
      { code: "5002", debit: BASE_WAGE, credit: 0 },
      { code: "2001", debit: 0, credit: BASE_WAGE },
    ],
  });

  entries.push({
    key: "wage-deductions",
    date: "2026-08-31",
    description:
      "Potongan gaji kurir — 2 hari tidak antar Juli (136.364) dan denda salah alamat 10 Agustus (20.000)",
    lines: [
      { code: "2001", debit: JULY_NON_DELIVERY + DENDA, credit: 0 },
      { code: "5002", debit: 0, credit: JULY_NON_DELIVERY + DENDA },
    ],
  });

  entries.push({
    key: "advance-offset",
    date: "2026-08-31",
    description: "Kasbon kurir Agustus dipotong dari gaji",
    lines: [
      { code: "2001", debit: advanceTotal, credit: 0 },
      { code: "1201", debit: 0, credit: advanceTotal },
    ],
  });

  // Two transfers to DANA VA 3901089637579359 on 1 September. The first was
  // paid at 19:28 on demand, the balance at 21:43; together they are the
  // settlement exactly. September's BCA statement does not exist yet, so
  // these have no bank line to attach to.
  entries.push({
    key: "settlement-1",
    date: "2026-09-01",
    description: "Pelunasan gaji kurir Agustus 2026 — transfer 1 dari 2 (19:28)",
    lines: [
      { code: "2001", debit: 500000, credit: 0 },
      { code: "1002", debit: 0, credit: 500000 },
    ],
  });
  entries.push({
    key: "settlement-2",
    date: "2026-09-01",
    description: `Pelunasan gaji kurir Agustus 2026 — transfer 2 dari 2 (21:43)`,
    lines: [
      { code: "2001", debit: settlement - 500000, credit: 0 },
      { code: "1002", debit: 0, credit: settlement - 500000 },
    ],
  });

  // Every entry balances, and the whole set nets 1201 and the courier's slice
  // of 2001 to nil. If either check fails the arithmetic in this file is wrong
  // and nothing should be written.
  const net = new Map<string, number>();
  for (const e of entries) {
    const d = e.lines.reduce((s, l) => s + l.debit, 0);
    const c = e.lines.reduce((s, l) => s + l.credit, 0);
    if (d !== c) throw new Error(`${e.key} does not balance: ${d} vs ${c}`);
    for (const l of e.lines)
      net.set(l.code, (net.get(l.code) ?? 0) + l.debit - l.credit);
  }
  if (net.get("1201") !== 0) throw new Error(`1201 does not clear: ${net.get("1201")}`);
  if (net.get("2001") !== 0) throw new Error(`2001 does not clear: ${net.get("2001")}`);

  console.log(`advances ${advanceTotal.toLocaleString("id-ID")} over ${advances.length} rows`);
  console.log(`settlement ${settlement.toLocaleString("id-ID")} (paid 500.000 + ${(settlement - 500000).toLocaleString("id-ID")})`);
  console.log(`\n${entries.length} journals:`);
  for (const e of entries)
    console.log(
      `  ${e.date}  ${e.lines.map((l) => `${l.debit ? "Dr" : "Cr"} ${l.code} ${(l.debit || l.credit).toLocaleString("id-ID")}`).join(" / ")}  ${e.description.slice(0, 60)}`,
    );
  console.log("\nnet by account:");
  for (const [code, v] of [...net].sort())
    console.log(`  ${code}  ${v.toLocaleString("id-ID")}`);

  if (!apply) {
    console.log("\nDRY RUN. --apply to write.");
    return;
  }

  const { data: accts } = await db.from("accounts").select("id, code");
  const idFor = new Map((accts ?? []).map((a) => [a.code, a.id]));
  for (const code of new Set(entries.flatMap((e) => e.lines.map((l) => l.code))))
    if (!idFor.has(code)) throw new Error(`unknown account code: ${code}`);

  for (const e of entries) {
    const { data: dup } = await db
      .from("journals")
      .select("id")
      .eq("description", e.description)
      .maybeSingle();
    if (dup) {
      console.log(`  skip (exists): ${e.description.slice(0, 50)}`);
      continue;
    }

    const { data: ref, error: refErr } = await db.rpc("next_journal_reference", {
      p_year: Number(e.date.slice(0, 4)),
    });
    if (refErr || !ref) throw refErr ?? new Error("no reference");

    const { data: j, error: jErr } = await db
      .from("journals")
      .insert({
        reference: ref as string,
        description: e.description,
        date: e.date,
        source_type: "manual",
        source_id: null,
      })
      .select("id")
      .single();
    if (jErr) throw jErr;

    const { error: lErr } = await db.from("journal_lines").insert(
      e.lines.map((l) => ({
        journal_id: j.id,
        account_id: idFor.get(l.code) as string,
        debit: l.debit,
        credit: l.credit,
      })),
    );
    if (lErr) throw lErr;

    // An advance entry is the bank line's journal, so the line stops showing
    // up in the reconcile queue.
    const adv = advances.find((a) => a.id === e.key);
    if (adv) {
      const { error: bErr } = await db
        .from("bank_transactions")
        .update({ journal_id: j.id, matched_at: new Date().toISOString(), matched_by: ACTOR })
        .eq("id", adv.id);
      if (bErr) throw bErr;
    }

    await logEdit({
      db,
      actor: ACTOR,
      entityType: "journal",
      entityId: j.id,
      action: "post_journal",
      changes: { reference: ref, date: e.date, description: e.description, lines: e.lines },
    });
    console.log(`  ${ref}  ${e.date}  ${e.description.slice(0, 55)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
