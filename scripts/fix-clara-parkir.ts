/**
 * Clara Alicia (+628115297500) — Ruko Golden Boulevard G2 No. 46, BSD Lama.
 *
 * The ruko charges the courier Rp 3.000 to park. Thenie pays it at the gate and
 * bills it to us, so it is the same pass-through shape as the Rp 10.000 Akasa
 * ongkir: we charge the customer what the kitchen charges us, and it never
 * touches revenue or COGS.
 *
 * Three things, from Justin's call on 2026-09-08:
 *
 *   1. Thenie x Golden Boulevard gets a `subcontractor_neighborhoods` row at
 *      Rp 3.000 a drop, so every future order at that address prices the parkir
 *      by itself — the way Apartemen Akasa does at Rp 10.000.
 *   2. Clara's paid order bffe2ebb is charged for all 20 drops, not only the
 *      ones still ahead: Rp 3.000 x 20 = Rp 60.000, locked on the order the way
 *      `price_per_portion` is, and `total_price` 540.000 -> 600.000. A coverage
 *      rule never reaches an order that already exists, so this half is by hand.
 *   3. The books:
 *      - Clara owes the Rp 60.000 and has not paid it. Dr 1100 / Cr 2101 —
 *        Sharleen's JV-2026-634 is the same shape. When the transfer lands,
 *        book Dr 1002 / Cr 1100 by hand; the payment journal for this order is
 *        already posted and idempotent, so it will never re-post.
 *      - Rp 15.000 went to Thenie by BCA at 20.10 on 8 September, covering the
 *        five drops 4, 5, 7, 8 and 9 September. Dr 2001 / Cr 1002.
 *
 * 2001 reads negative until the delivery-journal backfill lands: nothing has
 * posted `ongkir_{date}_lunch` for September yet, so nothing has moved Clara's
 * parkir from 2101 to 2001 to be paid out of. `PUT /api/deliveries/daily-sheet`
 * reads `orders.delivery_surcharge_per_delivery`, which this script sets, so the
 * backfill will post all 20 drops at Rp 3.000 on its own. Same interim shape as
 * JV-2026-663.
 *
 * Nothing here tells Clara. She paid 540.000 for a package quoted without the
 * parkir, so the top-up is a message an admin sends and Justin approves.
 *
 *   set -a && . ./.env.local && set +a && pnpm tsx scripts/fix-clara-parkir.ts [--apply]
 */
import { logEdit } from "../src/lib/audit/log-edit";
import { createAdminClient } from "../src/lib/supabase/admin";

const ACTOR = "system:clara-parkir-2026-09-08";
const DATE = "2026-09-08";

const THENIE_ID = "52cd5e62-da09-49c9-939c-2f1246566c40";
const GOLDEN_BOULEVARD_ID = "3728aadc-58c2-4dd4-95cc-1038b13e696b";
const CLARA_ID = "56fe9c9a-071d-43be-8942-3a6a81500591";
const ORDER_ID = "bffe2ebb-2623-495c-8a3e-c063711ad41a";

const PARKIR_PER_DROP = 3000;
const DROPS = 20; // the whole package — see (2) above
const PARKIR_TOTAL = PARKIR_PER_DROP * DROPS; // 60.000
const OLD_TOTAL_PRICE = 540000;
const NEW_TOTAL_PRICE = OLD_TOTAL_PRICE + PARKIR_TOTAL; // 600.000

const PAID_TO_KITCHEN = 15000; // 5 drops x 3.000, BCA 08 Sep 2026 20.10.44

type Line = { code: string; debit: number; credit: number };
type Entry = {
  sourceId: string;
  description: string;
  notes: string;
  lines: Line[];
};

const ENTRIES: Entry[] = [
  {
    sourceId: "parkir_clara_piutang_2026-09-08",
    description:
      "Piutang parkir Clara Alicia — 20 drop × Rp 3.000 (order bffe2ebb)",
    notes:
      "Ruko Golden Boulevard G2 No. 46 menagih parkir Rp 3.000 per drop; dapur partner membayarkannya di pintu dan menagih ke kami. " +
      "Sama seperti ongkir Apartemen Akasa: pass-through, bukan pendapatan, jadi masuk 2101 Unearned Delivery Fee dan bukan 2100. " +
      "Pesanan bffe2ebb sudah lunas Rp 540.000 untuk 20 porsi tanpa parkir, jadi Rp 60.000 ini masih tertagih — bentuknya sama dengan JV-2026-634 (piutang ongkir Sharleen). " +
      "Saat transfernya masuk, catat manual Dr 1002 / Cr 1100; jurnal order_payment pesanan ini sudah ada dan idempotent, jadi tidak akan pernah terbit ulang.",
    lines: [
      { code: "1100", debit: PARKIR_TOTAL, credit: 0 },
      { code: "2101", debit: 0, credit: PARKIR_TOTAL },
    ],
  },
  {
    sourceId: "parkir_thenie_2026-09-08",
    description:
      "Pembayaran parkir ke dapur partner — 5 drop Clara Alicia × Rp 3.000",
    notes:
      "Transfer BCA 08 Sep 2026 20.10.44 ke 866-028-1402 a.n. R BG ANDREAS KURNIANTO, Rp 15.000. " +
      "Menutup parkir lima drop: 4, 5, 7, 8 dan 9 September 2026 (9 September sudah lewat cutoff H-1 16.00, jadi ikut dibayar di muka). " +
      "2001 minus sampai backfill jurnal harian jalan: jurnal ongkir_{tanggal}_lunch belum pernah diposting untuk September, jadi belum ada yang memindahkan parkir Clara dari 2101 ke 2001. " +
      "Backfill nanti membaca orders.delivery_surcharge_per_delivery — sudah diisi Rp 3.000 oleh skrip ini — dan akan memposting seluruh 20 drop sendiri. Pola interim yang sama dengan JV-2026-663.",
    lines: [
      { code: "2001", debit: PAID_TO_KITCHEN, credit: 0 },
      { code: "1002", debit: 0, credit: PAID_TO_KITCHEN },
    ],
  },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  for (const e of ENTRIES) {
    const debit = e.lines.reduce((s, l) => s + l.debit, 0);
    const credit = e.lines.reduce((s, l) => s + l.credit, 0);
    if (debit !== credit)
      throw new Error(`${e.sourceId} does not balance: ${debit} vs ${credit}`);
  }

  const { data: order, error: oErr } = await db
    .from("orders")
    .select(
      "id, status, package_size, total_price, delivery_surcharge_per_delivery, delivery_surcharge_total",
    )
    .eq("id", ORDER_ID)
    .single();
  if (oErr) throw oErr;
  if (order.total_price !== OLD_TOTAL_PRICE)
    throw new Error(
      `total_price is ${order.total_price}, expected ${OLD_TOTAL_PRICE} — order changed since this script was written`,
    );

  const { count: rows } = await db
    .from("daily_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("order_id", ORDER_ID);
  if (rows !== DROPS)
    throw new Error(`${rows} delivery rows, expected ${DROPS}`);

  const { data: existingRule } = await db
    .from("subcontractor_neighborhoods")
    .select("id, can_deliver, surcharge_per_delivery")
    .eq("subcontractor_id", THENIE_ID)
    .eq("neighborhood_id", GOLDEN_BOULEVARD_ID)
    .maybeSingle();

  console.log("1. Thenie × Golden Boulevard");
  console.log(
    existingRule
      ? `   row exists: can_deliver=${existingRule.can_deliver}, surcharge=${existingRule.surcharge_per_delivery} → ${PARKIR_PER_DROP}`
      : `   insert: can_deliver=true, surcharge_per_delivery=${PARKIR_PER_DROP}`,
  );
  console.log(`2. order ${ORDER_ID.slice(0, 8)}`);
  console.log(
    `   delivery_surcharge_per_delivery ${order.delivery_surcharge_per_delivery} → ${PARKIR_PER_DROP}`,
  );
  console.log(
    `   delivery_surcharge_total ${order.delivery_surcharge_total} → ${PARKIR_TOTAL}`,
  );
  console.log(
    `   total_price ${OLD_TOTAL_PRICE.toLocaleString("id-ID")} → ${NEW_TOTAL_PRICE.toLocaleString("id-ID")}`,
  );
  console.log("3. journals");
  for (const e of ENTRIES) {
    const { data: dup } = await db
      .from("journals")
      .select("reference")
      .eq("source_type", "manual")
      .eq("source_id", e.sourceId)
      .maybeSingle();
    console.log(`   ${DATE}  ${e.description}${dup ? ` — already ${dup.reference}` : ""}`);
    for (const l of e.lines)
      console.log(
        `     ${l.debit ? "Dr" : "Cr"} ${l.code}  ${(l.debit || l.credit).toLocaleString("id-ID")}`,
      );
  }

  if (!apply) {
    console.log("\nDRY RUN. --apply to write.");
    return;
  }

  if (existingRule) {
    const { error } = await db
      .from("subcontractor_neighborhoods")
      .update({
        can_deliver: true,
        surcharge_per_delivery: PARKIR_PER_DROP,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingRule.id);
    if (error) throw error;
  } else {
    const { error } = await db.from("subcontractor_neighborhoods").insert({
      subcontractor_id: THENIE_ID,
      neighborhood_id: GOLDEN_BOULEVARD_ID,
      can_deliver: true,
      surcharge_per_delivery: PARKIR_PER_DROP,
    });
    if (error) throw error;
  }
  await logEdit({
    db,
    actor: ACTOR,
    entityType: "subcontractor_neighborhood",
    entityId: GOLDEN_BOULEVARD_ID,
    action: existingRule ? "update" : "create",
    changes: {
      subcontractor_id: THENIE_ID,
      neighborhood: "Golden Boulevard",
      surcharge_per_delivery: PARKIR_PER_DROP,
      reason: "parkir ruko Rp 3.000 per drop, ditagihkan dapur partner ke kami",
    },
  });
  console.log("coverage row written");

  const { error: uErr } = await db
    .from("orders")
    .update({
      delivery_surcharge_per_delivery: PARKIR_PER_DROP,
      delivery_surcharge_total: PARKIR_TOTAL,
      total_price: NEW_TOTAL_PRICE,
    })
    .eq("id", ORDER_ID);
  if (uErr) throw uErr;
  await logEdit({
    db,
    actor: ACTOR,
    entityType: "order",
    entityId: ORDER_ID,
    action: "update",
    changes: {
      customer_id: CLARA_ID,
      delivery_surcharge_per_delivery: {
        from: order.delivery_surcharge_per_delivery,
        to: PARKIR_PER_DROP,
      },
      delivery_surcharge_total: {
        from: order.delivery_surcharge_total,
        to: PARKIR_TOTAL,
      },
      total_price: { from: OLD_TOTAL_PRICE, to: NEW_TOTAL_PRICE },
      reason:
        "parkir Ruko Golden Boulevard Rp 3.000 × 20 drop, belum ditagihkan saat order dibuat",
    },
  });
  console.log("order updated");

  const { data: accts } = await db.from("accounts").select("id, code");
  const idFor = new Map((accts ?? []).map((a) => [a.code, a.id]));

  for (const e of ENTRIES) {
    for (const l of e.lines)
      if (!idFor.has(l.code)) throw new Error(`unknown account code: ${l.code}`);

    const { data: dup } = await db
      .from("journals")
      .select("reference")
      .eq("source_type", "manual")
      .eq("source_id", e.sourceId)
      .maybeSingle();
    if (dup) {
      console.log(`${e.sourceId} already posted as ${dup.reference}`);
      continue;
    }

    const { data: ref, error: refErr } = await db.rpc(
      "next_journal_reference",
      { p_year: Number(DATE.slice(0, 4)) },
    );
    if (refErr || !ref) throw refErr ?? new Error("no reference");

    const { data: j, error: jErr } = await db
      .from("journals")
      .insert({
        reference: ref as string,
        description: e.description,
        date: DATE,
        source_type: "manual",
        source_id: e.sourceId,
        notes: e.notes,
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
    if (lErr) {
      // A header with no lines would block every retry: the guard only looks
      // for the header.
      await db.from("journals").delete().eq("id", j.id);
      throw lErr;
    }

    await logEdit({
      db,
      actor: ACTOR,
      entityType: "journal",
      entityId: j.id,
      action: "create",
      changes: {
        reference: ref,
        date: DATE,
        description: e.description,
        lines: e.lines,
      },
    });
    console.log(`posted ${ref} — ${e.description}`);
  }
}

main();
