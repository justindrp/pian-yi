/**
 * Writes docs/OVERDRAW.md — every customer whose deliveries exceed the portions they
 * bought. Run after any reconciliation that moves orders or deliveries.
 *
 * `bought` sums package_size over non-cancelled orders; `drawn` sums portions
 * over all delivery rows. Customers whose deliveries draw from someone else's
 * package via customers.linked_order_id are reported against that package, not
 * their own, so a shared family order is not counted as an overdraw twice.
 */
import * as fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { requiredEnv } from "../src/lib/env";

dotenv.config({ path: ".env.local" });

const db = createClient(
  requiredEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  requiredEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ),
);
const CANCELLED = [
  "cancelled_unpaid",
  "cancelled_by_customer",
  "cancelled_by_admin",
  "refunded",
];

async function all<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from(table)
      .select(cols)
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

type Cust = {
  id: string;
  name: string | null;
  phone_number: string | null;
  linked_order_id: string | null;
};
type Ord = {
  id: string;
  customer_id: string | null;
  package_size: number | null;
  status: string;
  source: string | null;
};
type Del = {
  id: string;
  customer_id: string | null;
  portions: number | null;
  delivery_date: string;
};

async function main() {
  const custs = await all<Cust>(
    "customers",
    "id, name, phone_number, linked_order_id",
  );
  const orders = await all<Ord>(
    "orders",
    "id, customer_id, package_size, status, source",
  );
  const dels = await all<Del>(
    "daily_deliveries",
    "id, customer_id, portions, delivery_date",
  );

  const orderOwner = new Map(orders.map((o) => [o.id, o.customer_id]));
  // A customer with linked_order_id eats from another customer's package, so
  // both their purchases and their draws belong to that package's owner.
  const resolve = (id: string) => {
    const c = custs.find((x) => x.id === id);
    const linked = c?.linked_order_id
      ? orderOwner.get(c.linked_order_id)
      : null;
    return linked ?? id;
  };

  const bought = new Map<string, number>();
  const free = new Map<string, number>();
  for (const o of orders) {
    if (!o.customer_id || CANCELLED.includes(o.status)) continue;
    const key = resolve(o.customer_id);
    const m = o.source === "free_quota" ? free : bought;
    m.set(key, (m.get(key) ?? 0) + (o.package_size ?? 0));
  }

  const drawn = new Map<string, number>();
  const last = new Map<string, string>();
  const sharedBy = new Map<string, Set<string>>();
  for (const d of dels) {
    if (!d.customer_id) continue;
    const key = resolve(d.customer_id);
    if (key !== d.customer_id) {
      const set = sharedBy.get(key) ?? new Set<string>();
      set.add(d.customer_id);
      sharedBy.set(key, set);
    }
    drawn.set(key, (drawn.get(key) ?? 0) + (d.portions ?? 0));
    if (!last.get(key) || d.delivery_date > (last.get(key) ?? ""))
      last.set(key, d.delivery_date);
  }

  const rows = [...drawn.keys()]
    .map((id) => {
      const c = custs.find((x) => x.id === id);
      const b = (bought.get(id) ?? 0) + (free.get(id) ?? 0);
      const dr = drawn.get(id) ?? 0;
      const shared = [...(sharedBy.get(id) ?? [])].map(
        (sid) => custs.find((x) => x.id === sid)?.name ?? "?",
      );
      return {
        name: c?.name ?? "(unnamed)",
        bought: b,
        drawn: dr,
        balance: b - dr,
        last: last.get(id) ?? "",
        shared,
      };
    })
    .filter((r) => r.balance < 0)
    .sort((a, b) => a.balance - b.balance);

  const total = rows.reduce((s, r) => s + r.balance, 0);
  const noPurchase = rows.filter((r) => r.bought === 0);

  const md = [
    "# Overdraw — customers who ate more than they bought",
    "",
    `Generated ${new Date().toISOString().slice(0, 10)} by \`scripts/export-overdraw.ts\`.`,
    "",
    `**${rows.length} customers, ${Math.abs(total)} portions over.**`,
    "",
    "Format: `[name] +[bought] -[drawn] [balance]`. `bought` counts non-cancelled",
    "orders including any free-quota grants already recorded. Customers sharing a",
    "package via `linked_order_id` are folded into the package owner's line.",
    "",
    "```",
    ...rows.map((r) => `${r.name} +${r.bought} -${r.drawn} ${r.balance}`),
    "```",
    "",
    "## Detail",
    "",
    "| Customer | Bought | Drawn | Balance | Last delivery | Notes |",
    "|---|---:|---:|---:|---|---|",
    ...rows.map((r) => {
      const notes: string[] = [];
      if (r.bought === 0) notes.push("no purchases on file");
      if (r.shared.length) notes.push(`shared with ${r.shared.join(", ")}`);
      return `| ${r.name} | ${r.bought} | ${r.drawn} | ${r.balance} | ${r.last} | ${notes.join("; ")} |`;
    }),
    "",
    "## Reading this",
    "",
    `${noPurchase.length} customers have no purchases on file at all` +
      (noPurchase.length
        ? ` (${noPurchase.map((r) => `${r.name} ${r.balance}`).join(", ")})`
        : "") +
      ". Verick, Kiliang and Kevin M last ate before the December package_orders backfill, so theirs are missing purchase records rather than granted quota. Gaylen is the exception: 1 portion bartered for a promo video, so hers is a genuine grant that has never been recorded as a free_quota order.",
    "",
    "No draw path checks the balance before writing, so the small 1-2 portion",
    "balances are as likely to be the missing guard as a deliberate grant. Free",
    "quota should only be recorded where it is independently verified.",
    "",
  ].join("\n");

  fs.writeFileSync("docs/OVERDRAW.md", md);
  console.log(
    `docs/OVERDRAW.md written: ${rows.length} customers, ${Math.abs(total)} portions over`,
  );
}
main();
