/**
 * Tiwi's ledger carried two defects, both from 2026-08-19.
 *
 * 1. Order a8e17a4d was created with the six days she actually asked for
 *    (19, 20, 21, 24, 26, 27 Agustus — skipping Sabtu 22 and Maulid Nabi on the
 *    25th). Marking it paid regenerated the standing Senin–Sabtu pattern and
 *    added those two skipped days on top, so a 6-porsi package held 8 draws.
 * 2. Order 9b9a78be is a phantom: she wrote a bare "Ok" the morning after
 *    paying, recovery rebuilt her existing order, and she was sent a second
 *    Rp 174.000 bill for a package she had already paid for.
 */
import { createAdminClient } from "../src/lib/supabase/admin";

const REAL_ORDER = "a8e17a4d";
const PHANTOM = "9b9a78be";
const CUSTOMER = "f3358085-3def-4f2e-9cbc-024c415a9e65";
/** The two days mark_paid added that her own schedule had skipped. */
const SURPLUS = ["2026-08-22", "2026-08-25"];

async function main() {
  const db = createAdminClient();
  const { data: orders } = await db
    .from("orders")
    .select("id, package_size, portions_remaining, status")
    .eq("customer_id", CUSTOMER);
  const real = (orders ?? []).find((o) => o.id.startsWith(REAL_ORDER));
  const phantom = (orders ?? []).find((o) => o.id.startsWith(PHANTOM));
  if (!real || !phantom) throw new Error("orders not found");

  for (const date of SURPLUS) {
    const { error } = await db
      .from("daily_deliveries")
      .delete()
      .eq("order_id", real.id)
      .eq("delivery_date", date);
    if (error) throw new Error(`${date}: ${error.message}`);
    console.log(`dropped ${date} from ${REAL_ORDER}`);
  }

  await db.from("daily_deliveries").delete().eq("order_id", phantom.id);
  await db
    .from("orders")
    .update({ status: "cancelled_by_admin" })
    .eq("id", phantom.id);
  console.log(`cancelled phantom ${PHANTOM} (${phantom.package_size} porsi)`);

  // The dead customer counter is still written on create; keep it consistent
  // with the cancellation the way cancel-phantom-orders.ts does.
  const { data: cust } = await db
    .from("customers")
    .select("portions_remaining")
    .eq("id", CUSTOMER)
    .single();
  const counter = Math.max(
    0,
    (cust?.portions_remaining ?? 0) - (phantom.package_size ?? 0),
  );
  await db
    .from("customers")
    .update({ portions_remaining: counter })
    .eq("id", CUSTOMER);

  const { data: left } = await db
    .from("daily_deliveries")
    .select("delivery_date")
    .eq("order_id", real.id)
    .order("delivery_date");
  console.log(
    `${REAL_ORDER}: pkg ${real.package_size}, rem ${real.portions_remaining}, ${left?.length} deliveries ${(left ?? []).map((d) => d.delivery_date.slice(5)).join(" ")}`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
