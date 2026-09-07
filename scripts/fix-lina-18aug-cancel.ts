/**
 * Unwinds the portion Lina Marlianty cancelled on 18 Agustus 2026.
 *
 * Her order 1a274dc3 is a lunch package, but the row for 18 Agustus was
 * written as dinner. It came from the batch created at order creation on
 * 2 Agustus, when `requested_schedule` did not exist yet and
 * `buildRecurringDeliveryRows()` inferred the days from a meal-preference
 * enum — the inference path deleted on 2026-08-28. Nothing here fixes code;
 * this is that path's residue.
 *
 * The courier went out against the dinner row, so the food arrived at the
 * wrong time of day. She cancelled the day ("Hari ini cancel saja ya kak",
 * 18 Agustus 05:10 UTC) and took the delivery on 19 Agustus instead. The row
 * was never deleted, so it kept eating one of her ten portions and it sits
 * inside two posted journals: JV-2026-598 (revenue, 1p x Rp 28.000) and
 * JV-2026-595 (COGS, 1 of 5p x Rp 21.000).
 *
 * Three corrections, and the second is the one worth reading:
 *
 *   1. Revenue reversal. Dr 4001 / Cr 2100. She did not eat it, so the money
 *      goes back to unearned revenue and stays hers, matching the portion the
 *      delete returns to her balance. Not a refund — she has the portion.
 *
 *   2. COGS reclassified, never reversed. The kitchen cooked it and we owe
 *      Thenie the Rp 21.000 either way, so 2001 must not move. But the portion
 *      was delivered to Justin and used for product photography, which makes
 *      it a marketing cost rather than the cost of a sale: Dr 6001 / Cr 5001.
 *      Reversing 5001 against 2001 instead would have cleared a payable that
 *      is genuinely owed, and left the photo shoot free.
 *
 *   3. The row itself, through deleteDelivery(), which copies it to edit_log
 *      first. Removing the row *is* the refund of the portion; nothing else is
 *      written and no counter is incremented.
 *
 * The Lalamove ride Justin ordered to Thenie's kitchen that day is deliberately
 * not here — he is booking it in his personal accounts.
 *
 * Run: pnpm tsx --env-file=.env.local scripts/fix-lina-18aug-cancel.ts [--apply]
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { deleteDelivery } from "@/lib/orders/delivery-state";

const ACTOR = "system:lina-18aug-cancel-2026-09-07";
const ROW_ID = "5a0b63ec-9675-4c7d-8dd1-cb014143618b";
const DATE = "2026-08-18";
const REVENUE = 28000;
const COGS = 21000;

const entries = [
  {
    description:
      "Pembatalan Lina Marlianty 18 Agustus - reversal pengakuan pendapatan 1 porsi",
    date: DATE,
    lines: [
      { code: "4001", debit: REVENUE, credit: 0 },
      { code: "2100", debit: 0, credit: REVENUE },
    ],
  },
  {
    description:
      "Porsi batal Lina Marlianty 18 Agustus dipakai untuk foto produk - reklasifikasi COGS ke marketing",
    date: DATE,
    lines: [
      { code: "6001", debit: COGS, credit: 0 },
      { code: "5001", debit: 0, credit: COGS },
    ],
  },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { data: row } = await db
    .from("daily_deliveries")
    .select("id, delivery_date, meal_type, portions, order_id, customer_id")
    .eq("id", ROW_ID)
    .maybeSingle();
  console.log("Delivery row:", row ? JSON.stringify(row) : "already gone");

  for (const e of entries) {
    console.log(`\n${e.date}  ${e.description}`);
    for (const l of e.lines)
      console.log(
        `  ${l.code}  Dr ${l.debit.toLocaleString("id-ID").padStart(9)}  Cr ${l.credit.toLocaleString("id-ID").padStart(9)}`,
      );
  }

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
      console.log(`\nskip (exists): ${e.description.slice(0, 60)}`);
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
    console.log(`\nposted ${ref}: ${e.description.slice(0, 60)}`);
  }

  if (row) {
    const deleted = await deleteDelivery({
      db,
      id: ROW_ID,
      actor: ACTOR,
      reason:
        "Lina Marlianty membatalkan 18 Agustus 2026 setelah porsi terkirim di jam makan malam, bukan makan siang (baris dinner keliru dari inferensi jadwal lama). Porsi dikembalikan ke kuotanya; makanannya dipakai untuk foto produk dan biayanya direklas ke 6001.",
    });
    console.log("\ndeleted row:", JSON.stringify(deleted));
  }
}

main();
