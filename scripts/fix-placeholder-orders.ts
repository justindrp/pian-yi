/**
 * Removes the three fabricated orders the 2026-06-08 import invented, and
 * writes Darren's real June package that was never imported.
 *
 * The import created one placeholder order per customer on the WhatsApp row and
 * hung every delivery off it, while the customer's real purchases were later
 * written by fix-no-orders.ts onto a duplicate customer row. After
 * dedup-phone-format.ts merged those rows, both sets sit on one customer, so
 * the placeholders double-count the purchase history — Valen's pkg=45 is
 * exactly her two real orders summed.
 *
 * Verified against the package_orders sheet:
 *   Defi Lugito  placeholder pkg=16   real 20 + 40 + 40 = 100, drew 106  (-6)
 *   Valen        placeholder pkg=45   real  5 + 40      =  45, drew  49  (-4)
 *   Darren       placeholder pkg=18   real 30 (missing) =  30, drew  33  (-3)
 *
 * Deliveries are re-pointed to the real orders by the same rule as
 * pickDrawOrder(): oldest order still holding balance, falling back to the
 * newest when every order is exhausted. Placeholders are deleted only once
 * nothing references them.
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

/** Placeholder order ids to delete, keyed by the customer they sit on. */
const PLACEHOLDERS: Record<string, string> = {
  Darren: "2d9caf30",
  Valen: "43720a64",
  "Defi Lugito": "10b0207e",
};

/** Darren's real June package, from the package_orders sheet row 06/02/2026. */
const DARREN_ORDER = {
  package_size: 30,
  price_per_portion: 26333,
  total_price: 790000,
  portions_per_delivery: 1,
  portions_remaining: 30, // recomputed from actual draws below
  // He has no standing pattern — his deliveries alternate lunch and dinner
  // ad hoc — and per_day_decision keeps auto-generation from inventing rows
  // for him (see FIXED_SCHEDULE_PREFS).
  meal_time_preference: "per_day_decision",
  status: "active",
  source: "purchase",
  start_date: "2026-06-03", // his first delivery; the sheet row is the purchase
  created_at: "2026-06-02T00:40:00+07:00",
};

type Order = {
  id: string;
  customer_id: string;
  package_size: number | null;
  portions_remaining: number | null;
  status: string;
  start_date: string | null;
  created_at: string | null;
};

type Delivery = {
  id: string;
  order_id: string | null;
  portions: number | null;
  delivery_date: string;
};

async function main() {
  const rollback: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    customers: {},
  };

  // Flushed before each customer's writes so a mid-run failure still leaves a
  // file holding the original order_id of every delivery about to move.
  const dir = path.join(__dirname, "rollback");
  const file = path.join(dir, `placeholder-orders-${Date.now()}.json`);
  const flush = () => {
    if (!APPLY) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rollback, null, 2));
  };

  for (const [name, prefix] of Object.entries(PLACEHOLDERS)) {
    const { data: custs, error: cErr } = await db
      .from("customers")
      .select("id, name")
      .eq("name", name);
    if (cErr) throw new Error(cErr.message);
    if (custs?.length !== 1) {
      throw new Error(`expected 1 customer named "${name}", got ${custs?.length}`);
    }
    const customer = custs[0];

    const { data: orders, error: oErr } = await db
      .from("orders")
      .select(
        "id, customer_id, package_size, portions_remaining, status, start_date, created_at",
      )
      .eq("customer_id", customer.id);
    if (oErr) throw new Error(oErr.message);

    const placeholder = (orders as Order[]).find((o) => o.id.startsWith(prefix));
    if (!placeholder) throw new Error(`placeholder ${prefix} not found for ${name}`);

    let real = (orders as Order[]).filter((o) => o.id !== placeholder.id);

    console.log(`\n=== ${name} ===`);
    console.log(
      `  DELETE placeholder ${placeholder.id.slice(0, 8)} pkg=${placeholder.package_size}`,
    );

    // Darren's real order is not in the database at all — the import wrote only
    // the placeholder for him, so there is nothing to re-point onto yet.
    if (real.length === 0) {
      console.log(
        `  CREATE order pkg=${DARREN_ORDER.package_size} @ ${DARREN_ORDER.price_per_portion} = ${DARREN_ORDER.total_price}`,
      );
      if (APPLY) {
        const { data: created, error } = await db
          .from("orders")
          .insert({ ...DARREN_ORDER, customer_id: customer.id })
          .select(
            "id, customer_id, package_size, portions_remaining, status, start_date, created_at",
          )
          .single();
        if (error) throw new Error(`create order: ${error.message}`);
        real = [created as Order];
        console.log(`    created ${created.id}`);
      } else {
        // Dry run: stand in for the row so the draw simulation below can run.
        real = [
          {
            id: "(new)",
            customer_id: customer.id,
            package_size: DARREN_ORDER.package_size,
            portions_remaining: DARREN_ORDER.package_size,
            status: DARREN_ORDER.status,
            start_date: DARREN_ORDER.start_date,
            created_at: DARREN_ORDER.created_at,
          },
        ];
      }
    }

    const { data: deliveries, error: dErr } = await db
      .from("daily_deliveries")
      .select("id, order_id, portions, delivery_date")
      .eq("customer_id", customer.id)
      .order("delivery_date", { ascending: true });
    if (dErr) throw new Error(dErr.message);

    // Oldest-first by start_date, matching pickDrawOrder's ordering.
    real.sort((a, b) =>
      (a.start_date ?? a.created_at ?? "").localeCompare(
        b.start_date ?? b.created_at ?? "",
      ),
    );

    const capacity = new Map<string, number>(
      real.map((o) => [o.id, o.package_size ?? 0]),
    );
    const assignment = new Map<string, string>(); // delivery id -> order id

    for (const d of (deliveries ?? []) as Delivery[]) {
      const target =
        real.find((o) => (capacity.get(o.id) ?? 0) > 0) ?? real[real.length - 1];
      capacity.set(target.id, (capacity.get(target.id) ?? 0) - (d.portions ?? 0));
      assignment.set(d.id, target.id);
    }

    const drawn = (deliveries ?? []).reduce(
      (s, d) => s + (d.portions ?? 0),
      0,
    );
    const bought = real.reduce((s, o) => s + (o.package_size ?? 0), 0);
    console.log(
      `  ${deliveries?.length ?? 0} deliveries, ${drawn} portions drawn vs ${bought} bought -> balance ${bought - drawn}`,
    );
    for (const o of real) {
      const moved = [...assignment.values()].filter((v) => v === o.id).length;
      console.log(
        `    ord ${o.id.slice(0, 8)} pkg=${o.package_size} <- ${moved} deliveries, remaining ${capacity.get(o.id)}`,
      );
    }

    (rollback.customers as Record<string, unknown>)[name] = {
      customer_id: customer.id,
      placeholder,
      deliveries_before: deliveries,
      orders_before: orders,
    };
    flush();

    if (!APPLY) continue;

    for (const [deliveryId, orderId] of assignment) {
      const { error } = await db
        .from("daily_deliveries")
        .update({ order_id: orderId })
        .eq("id", deliveryId);
      if (error) throw new Error(`repoint delivery: ${error.message}`);
    }

    for (const o of real) {
      const { error } = await db
        .from("orders")
        .update({ portions_remaining: capacity.get(o.id) ?? 0 })
        .eq("id", o.id);
      if (error) throw new Error(`update balance: ${error.message}`);
    }

    const { error: delErr } = await db
      .from("orders")
      .delete()
      .eq("id", placeholder.id);
    if (delErr) throw new Error(`delete placeholder: ${delErr.message}`);
    console.log(`  placeholder deleted`);
  }

  if (APPLY) {
    flush();
    console.log(`\nApplied. Rollback written to ${file}`);
  } else {
    console.log("\nDry run. Re-run with --apply to write.");
  }
}

main();
