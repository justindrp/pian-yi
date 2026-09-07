/**
 * Posts the on-time guarantee payout for Tiara's 7 September 2026 lunch.
 *
 * The promise is 11.30–12.30 WIB. The portion arrived after 13.00, she chased
 * us from 12.55 and bought her ART food elsewhere while waiting. Under the
 * guarantee a portion received after 12.30 is charged at half price, so
 * Rp 29.000 / 2 = Rp 14.500 went back to her by BCA transfer at 17.18 WIB.
 *
 * This is a price reduction, not a refund of something undelivered: she kept
 * the food and the 2026-09-07 delivery row stays on her order, so the ledger
 * still reads 6 bought / 6 booked. It is therefore booked against revenue
 * (Dr 4001), the way Carolin's 50% compensation was in JV-2026-639, and not
 * against 2100 the way Pane's and Evelyn's cancellations were.
 *
 * The delivery journal for 2026-09-07 does not exist yet — nothing posts them
 * automatically and the backfill is a separate task. When it lands it must
 * still recognise the full Rp 29.000 out of 2100 into 4001; with this entry
 * against it the portion nets to the Rp 14.500 we actually earned. Debiting
 * 4001 before that recognition is what makes the account read low in the
 * meantime, exactly as JV-2026-639 does.
 *
 * Run: tsx --env-file=.env.local scripts/post-tiara-late-compensation.ts [--apply]
 */
import { logEdit } from "../src/lib/audit/log-edit";
import { createAdminClient } from "../src/lib/supabase/admin";

const ACTOR = "system:tiara-late-compensation-2026-09-07";
const ORDER_ID = "06c91ede-deb3-4a73-a750-15595b7271bd";
const DATE = "2026-09-07";
const PRICE_PER_PORTION = 29000;
const AMOUNT = PRICE_PER_PORTION / 2; // 14.500 — one portion at half price

const DESCRIPTION =
  "Kompensasi jaminan tepat waktu 50% — Tiara, porsi siang 7 September 2026";
const NOTES =
  "Transfer BCA 07 Sep 2026 17.18.08 ke 194-123-5731 a.n. TIARA HARTANTO, Rp 14.500. " +
  "Janji kirim siang 11.30-12.30 WIB; porsi baru sampai lewat jam 13.00 dan customer komplain dari 12.55. " +
  "Jaminan tepat waktu memotong 50% dari Rp 29.000/porsi untuk porsi yang diterima lewat 12.30. " +
  "Porsi tetap diterima, jadi baris pengiriman 2026-09-07 tetap ada dan kuotanya tetap 6 dibeli / 6 terjadwal — " +
  "ini pengurang pendapatan (Dr 4001), bukan refund dari 2100 seperti JV-2026-638 dan JV-2026-658. " +
  "Jurnal delivery 2026-09-07 nanti tetap mengakui Rp 29.000 penuh dari 2100 ke 4001; bersihnya Rp 14.500. " +
  "Pola sama dengan JV-2026-639 (Carolin).";

const LINES = [
  { code: "4001", debit: AMOUNT, credit: 0 },
  { code: "1002", debit: 0, credit: AMOUNT },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const debit = LINES.reduce((s, l) => s + l.debit, 0);
  const credit = LINES.reduce((s, l) => s + l.credit, 0);
  if (debit !== credit) throw new Error(`does not balance: ${debit} vs ${credit}`);

  // The guard is the same one createJournalEntry() uses: one refund per order.
  const { data: dup } = await db
    .from("journals")
    .select("reference")
    .eq("source_type", "refund")
    .eq("source_id", ORDER_ID)
    .maybeSingle();
  if (dup) {
    console.log(`already posted as ${dup.reference} — nothing to do`);
    return;
  }

  const { data: accts } = await db.from("accounts").select("id, code");
  const idFor = new Map((accts ?? []).map((a) => [a.code, a.id]));
  for (const l of LINES)
    if (!idFor.has(l.code)) throw new Error(`unknown account code: ${l.code}`);

  console.log(`${DATE}  ${DESCRIPTION}`);
  for (const l of LINES)
    console.log(
      `  ${l.debit ? "Dr" : "Cr"} ${l.code}  ${(l.debit || l.credit).toLocaleString("id-ID")}`,
    );

  if (!apply) {
    console.log("\nDRY RUN. --apply to write.");
    return;
  }

  const { data: ref, error: refErr } = await db.rpc("next_journal_reference", {
    p_year: Number(DATE.slice(0, 4)),
  });
  if (refErr || !ref) throw refErr ?? new Error("no reference");

  const { data: j, error: jErr } = await db
    .from("journals")
    .insert({
      reference: ref as string,
      description: DESCRIPTION,
      date: DATE,
      source_type: "refund",
      source_id: ORDER_ID,
      notes: NOTES,
    })
    .select("id")
    .single();
  if (jErr) throw jErr;

  const { error: lErr } = await db.from("journal_lines").insert(
    LINES.map((l) => ({
      journal_id: j.id,
      account_id: idFor.get(l.code) as string,
      debit: l.debit,
      credit: l.credit,
    })),
  );
  if (lErr) {
    // A header with no lines would block every future retry, because the
    // idempotency guard only looks for the header.
    await db.from("journals").delete().eq("id", j.id);
    throw lErr;
  }

  await logEdit({
    db,
    actor: ACTOR,
    entityType: "journal",
    entityId: j.id,
    action: "create",
    changes: { reference: ref, date: DATE, description: DESCRIPTION, lines: LINES },
  });

  console.log(`posted ${ref}`);
}

main();
