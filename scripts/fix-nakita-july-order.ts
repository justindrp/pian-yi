/**
 * Nakita paid for a package on 21 Juli 2026 that was never written down.
 *
 * The chat on 20 Juli is unambiguous. She needed 3 hari x 4 porsi = 12 porsi
 * for 22-24 Juli, held 1 porsi on an older package, took the 10-porsi option
 * (Rp 270.000, corrected by an admin to Rp 280.000 — Rp 28.000/porsi), then
 * added a portion for her child: "Pesan 11 porsi ya kak". The bot sent the
 * bank details for Rp 308.000 = 11 x Rp 28.000 at 11:30, she transferred that
 * night, and the BCA credit "NAQHITA SUHANDA Rp 308.000" landed on 21/07.
 *
 * No order was created. `extract_order` was never called — this is the failure
 * `flagOrderAtRisk()` was later built for: a reply that implies an order and
 * writes nothing. The six delivery rows for 22-24 Juli (lunch + dinner, 2 porsi
 * each) were inserted against 0f573639, a May package of 12 porsi that already
 * held 9 draws, taking it to 21 draws on 12 bought.
 *
 * This writes the order she paid for and moves those six rows onto it.
 *
 * The arithmetic afterwards is deliberately not floored per order: the new
 * order books 12 porsi against 11 bought, because the twelfth is the 1 porsi
 * she was told she still had. Netted at the customer level, as the ledger does
 * it, she bought 43 and drew 41. Do not "fix" the -1 by trimming a row.
 *
 * Run with --apply; without it, prints what it would do.
 */
import { logEdit } from "../src/lib/audit/log-edit";
import { createAdminClient } from "../src/lib/supabase/admin";

const CUSTOMER = "258407bc-c107-45d8-9679-003969a07fe9";
/** The May package the July rows were wrongly charged to. */
const WRONG_ORDER = "0f573639";
/** Dapur 1, which she named in the chat and which the rows already carry. */
const KITCHEN = "52cd5e62-da09-49c9-939c-2f1246566c40";
const DATES = ["2026-07-22", "2026-07-23", "2026-07-24"];
const ACTOR = "system:fix-nakita-july-order-2026-09-01";

const ORDER = {
  customer_id: CUSTOMER,
  package_size: 11,
  price_per_portion: 28000,
  total_price: 308000,
  amount_paid: 308000,
  portions_per_delivery: 2,
  status: "completed",
  size: "s",
  source: "purchase",
  subcontractor_id: KITCHEN,
  start_date: "2026-07-22",
  end_date: "2026-07-24",
  // Bank details sent 11:30, proof at 00:44 the next morning, last delivery
  // photo on the 24th.
  confirmed_at: "2026-07-20T11:30:45+00:00",
  paid_at: "2026-07-21T00:44:27+00:00",
  payment_proof_received_at: "2026-07-21T00:44:27+00:00",
  completed_at: "2026-07-24T10:32:34+00:00",
  lunch_address_slot: 1,
  dinner_address_slot: 1,
  // Left null on purpose. The rows already exist and are the truth; this
  // column is only ever read by mark_paid, which must not run on this order.
  requested_schedule: null,
};

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { data: orders } = await db
    .from("orders")
    .select("id, package_size, total_price, status, start_date")
    .eq("customer_id", CUSTOMER);
  const wrong = (orders ?? []).find((o) => o.id.startsWith(WRONG_ORDER));
  if (!wrong) throw new Error(`${WRONG_ORDER} not found`);
  if ((orders ?? []).some((o) => o.total_price === 308000)) {
    console.log("order already exists — nothing to do");
    return;
  }

  const { data: rows } = await db
    .from("daily_deliveries")
    .select("id, delivery_date, meal_type, portions, order_id")
    .eq("customer_id", CUSTOMER)
    .in("delivery_date", DATES)
    .order("delivery_date");
  const move = (rows ?? []).filter((r) => r.order_id === wrong.id);
  const portions = move.reduce((a, r) => a + (r.portions ?? 0), 0);
  console.log(
    `${move.length} rows / ${portions} porsi to move off ${WRONG_ORDER}`,
  );
  if (move.length !== 6)
    throw new Error(`expected 6 rows on ${WRONG_ORDER}, found ${move.length}`);

  if (!apply) {
    console.log("dry run — pass --apply");
    return;
  }

  const { data: created, error } = await db
    .from("orders")
    .insert(ORDER)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  console.log(`created ${created.id}`);

  await logEdit({
    db,
    actor: ACTOR,
    entityType: "order",
    entityId: created.id,
    action: "create",
    changes: {
      after: ORDER,
      reason:
        "Dibayar Rp 308.000 pada 21/07/2026 (11 porsi x Rp 28.000, chat 20/07 11:23-11:30) tapi ordernya tidak pernah dibuat.",
    },
  });

  for (const r of move) {
    const { error: e } = await db
      .from("daily_deliveries")
      .update({ order_id: created.id })
      .eq("id", r.id);
    if (e) throw new Error(`${r.delivery_date}: ${e.message}`);
    await logEdit({
      db,
      actor: ACTOR,
      entityType: "daily_delivery",
      entityId: r.id,
      action: "repoint_order",
      changes: {
        delivery_date: r.delivery_date,
        meal_type: r.meal_type,
        portions: r.portions,
        from: { order_id: r.order_id },
        to: { order_id: created.id },
      },
    });
    console.log(`  ${r.delivery_date} ${r.meal_type} x${r.portions} -> new`);
  }

  for (const id of [created.id, wrong.id]) {
    const { data: o } = await db
      .from("orders")
      .select("id, package_size, status")
      .eq("id", id)
      .single();
    const { data: d } = await db
      .from("daily_deliveries")
      .select("portions")
      .eq("order_id", id);
    const drawn = (d ?? []).reduce((a, x) => a + (x.portions ?? 0), 0);
    console.log(
      `${id.slice(0, 8)} ${o?.status}: ${drawn} drawn / ${o?.package_size} bought`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
