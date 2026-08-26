/**
 * Points deliveries at the package they are actually covered by when the
 * customer eats from someone else's order via customers.linked_order_id.
 *
 * The field records the arrangement but nothing ever moved the delivery rows.
 * Darren Dior draws from his sister Daryn Dior's 16-porsi order 26744cb1; his
 * 10 March deliveries drew from his own pkg=0 import artifact instead, and
 * Daryn's own rows drew from a second pkg=0 artifact of hers, so the real order
 * sat untouched at rem=16 while both siblings looked like overdraws.
 *
 * Covers the linked customer's rows and the order owner's own rows, since both
 * come out of the same package. Balance is recomputed from actual draws.
 * Emptied pkg=0 artifacts are reported but left alone — they are part of the
 * wider ghost-order cleanup, not this fix.
 *
 * Dry run by default. Pass --apply to write; --apply writes a rollback file
 * first.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { requiredEnv } from "../src/lib/env";

dotenv.config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");

const db = createClient(
  requiredEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  requiredEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ),
);

async function main() {
  const { data: linked, error: lErr } = await db
    .from("customers")
    .select("id, name, linked_order_id")
    .not("linked_order_id", "is", null);
  if (lErr) throw new Error(lErr.message);

  if (!linked?.length) {
    console.log("No customers with linked_order_id.");
    return;
  }

  const rollback: Record<string, unknown>[] = [];
  const dir = path.join(__dirname, "rollback");
  const file = path.join(dir, `linked-order-draws-${Date.now()}.json`);
  const flush = () => {
    if (!APPLY) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rollback, null, 2));
  };

  for (const customer of linked) {
    const orderId = customer.linked_order_id as string;

    const { data: order, error: oErr } = await db
      .from("orders")
      .select("id, customer_id, package_size, portions_remaining, status")
      .eq("id", orderId)
      .single();
    if (oErr) throw new Error(`order ${orderId}: ${oErr.message}`);

    const { data: owner } = await db
      .from("customers")
      .select("id, name")
      .eq("id", order.customer_id)
      .single();

    console.log(
      `\n${customer.name} -> order ${order.id.slice(0, 8)} (pkg=${order.package_size}) owned by ${owner?.name}`,
    );

    // Both siblings' rows come out of the one package.
    const { data: rows, error: dErr } = await db
      .from("daily_deliveries")
      .select("id, customer_id, order_id, portions, delivery_date")
      .in("customer_id", [customer.id, order.customer_id])
      .order("delivery_date", { ascending: true });
    if (dErr) throw new Error(dErr.message);

    const toMove = (rows ?? []).filter((r) => r.order_id !== orderId);
    const drawn = (rows ?? []).reduce((s, r) => s + (r.portions ?? 0), 0);
    const remaining = (order.package_size ?? 0) - drawn;

    const byCustomer = new Map<string, number>();
    for (const r of rows ?? []) {
      const key =
        r.customer_id === customer.id ? customer.name : (owner?.name ?? "?");
      byCustomer.set(key, (byCustomer.get(key) ?? 0) + (r.portions ?? 0));
    }
    for (const [who, n] of byCustomer) console.log(`    ${who}: ${n} portions`);
    console.log(
      `    ${toMove.length} of ${rows?.length ?? 0} rows to re-point; balance ${order.portions_remaining} -> ${remaining}`,
    );

    // Orders left holding nothing once their rows move.
    const vacated = new Set(
      toMove.map((r) => r.order_id).filter((id): id is string => !!id),
    );
    for (const id of vacated) {
      const { count } = await db
        .from("daily_deliveries")
        .select("id", { count: "exact", head: true })
        .eq("order_id", id);
      const stillUsed =
        (count ?? 0) - toMove.filter((r) => r.order_id === id).length;
      if (stillUsed === 0) {
        console.log(
          `    order ${id.slice(0, 8)} left with no deliveries (ghost artifact, not deleted)`,
        );
      }
    }

    rollback.push({
      customer: customer.name,
      linked_order: order,
      deliveries_before: rows,
    });
    flush();

    if (!APPLY) continue;

    for (const r of toMove) {
      const { error } = await db
        .from("daily_deliveries")
        .update({ order_id: orderId })
        .eq("id", r.id);
      if (error) throw new Error(`repoint ${r.id}: ${error.message}`);
    }

    const { error: uErr } = await db
      .from("orders")
      .update({ portions_remaining: remaining })
      .eq("id", orderId);
    if (uErr) throw new Error(`balance: ${uErr.message}`);
    console.log("    applied");
  }

  console.log(
    APPLY
      ? `\nApplied. Rollback written to ${file}`
      : "\nDry run. Re-run with --apply to write.",
  );
}

main();
