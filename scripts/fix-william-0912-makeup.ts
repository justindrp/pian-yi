/**
 * William Robert Budiono's 12 September dinner was deleted when the kitchen
 * did not cook that Saturday (the transfer to Thenie was missed; six rows went
 * back to quota that morning under `script:thenie-unpaid-2026-09-12`). Five of
 * his six paid portions have been delivered, the sixth has never been rebooked,
 * and his 24h window shut on 9 September so nothing could be agreed with him
 * in chat. Justin asked on 2026-09-15 for it to land on Wednesday 16
 * September.
 *
 * Booked here rather than through `recordDailyOrder()` because that path
 * refuses a locked date and 16 September locked at 16:00 today — which is the
 * whole reason this needs a human: the kitchen's sheet for tomorrow was final
 * before this row existed, so somebody has to tell them the Karawaci drop
 * carries one more box.
 *
 * The row is copied from his 15 September delivery so the frozen
 * `price_per_portion`, kitchen and address slot come from what he actually
 * bought, not from anything recomputed today.
 */
import { logEdit } from "../src/lib/audit/log-edit";
import { createAdminClient } from "../src/lib/supabase/admin";

const CUSTOMER = "William Robert Budiono";
const PHONE = "+62811274268";
const ORDER_PREFIX = "8b686ede";
const DATE = "2026-09-16";
const TEMPLATE_DATE = "2026-09-15";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { data: customer, error: cErr } = await db
    .from("customers")
    .select("id, name")
    .eq("phone_number", PHONE)
    .single();
  if (cErr) throw new Error(cErr.message);
  if (customer.name !== CUSTOMER) throw new Error(`${PHONE} is ${customer.name}`);

  const { data: order, error: oErr } = await db
    .from("orders")
    .select("id, status, package_size, subcontractor_id")
    .eq("customer_id", customer.id)
    .eq("status", "active")
    .single();
  if (oErr) throw new Error(oErr.message);
  if (!order.id.startsWith(ORDER_PREFIX))
    throw new Error(`active order is ${order.id}, not ${ORDER_PREFIX}`);

  const { data: rows, error: rErr } = await db
    .from("daily_deliveries")
    .select("*")
    .eq("order_id", order.id)
    .order("delivery_date");
  if (rErr) throw new Error(rErr.message);

  const booked = rows.reduce((sum, r) => sum + r.portions, 0);
  const unbooked = (order.package_size ?? 0) - booked;
  console.log(
    `${customer.name} — order ${order.id.slice(0, 8)}, package ${order.package_size}, booked ${booked}, unbooked ${unbooked}`,
  );
  if (unbooked !== 1) throw new Error(`expected 1 unbooked portion, found ${unbooked}`);

  if (rows.some((r) => r.delivery_date === DATE)) {
    console.log(`already has a row on ${DATE} — nothing to do`);
    return;
  }

  const template = rows.find((r) => r.delivery_date === TEMPLATE_DATE);
  if (!template) throw new Error(`no ${TEMPLATE_DATE} row to copy`);

  const { id: _id, created_at: _c, updated_at: _u, ...rest } = template;
  // `status` is gone (migration 075) — a row's existence is the whole truth.
  // The proof and feedback belong to the 15 September delivery, not this one.
  const row = {
    ...rest,
    delivery_date: DATE,
    delivery_proof_id: null,
    feedback_sentiment: null,
    feedback_message: null,
  };
  console.log(
    `${apply ? "booking" : "would book"} ${DATE} ${row.meal_type} x${row.portions} @ ${row.price_per_portion ?? "order rate"}, kitchen ${row.subcontractor_id?.slice(0, 8)}, slot ${row.address_slot ?? "-"}`,
  );
  if (!apply) return console.log("dry run — pass --apply");

  const { data: made, error: iErr } = await db
    .from("daily_deliveries")
    .insert(row as never)
    .select("id")
    .single();
  if (iErr) throw new Error(iErr.message);

  await logEdit({
    db,
    actor: "script:william-0912-makeup",
    entityType: "daily_deliveries",
    entityId: made.id,
    action: "create_delivery",
    changes: {
      row,
      reason:
        "Make-up for the 12 September dinner deleted when the kitchen did not cook; booked past the 16:00 cutoff on Justin's instruction, kitchen told by hand",
    },
  });
  console.log(`booked ${DATE} — delivery ${made.id}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
