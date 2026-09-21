/**
 * Replay revenue/COGS/ongkir accrual over every past delivery date.
 *
 * `accrueDeliveryDate()` is idempotent on `rev_{date}_{meal}` /
 * `cogs_{date}_{meal}` / `ongkir_{date}_{meal}`, so this writes only what is
 * missing and a second run is a no-op. It exists because
 * `/api/cron/accrue-deliveries` caps at `MAX_WINDOW_DAYS = 120` and the oldest
 * unaccrued date is 2025-12-29 — the cron cannot reach back that far.
 *
 * **Check the kitchen rates before running.** `kitchenCostPerPortion()` reads
 * whatever `subcontractors.cost_per_portion` holds today and there is no rate
 * history anywhere, so a replay prices Desember food at this month's rate. A
 * kitchen sitting at 0 is the dangerous case: its rows post revenue with no
 * cost at all, and idempotency means that bucket can never be rewritten — the
 * only repair is a manual adjusting entry per bucket. `--skip-kitchen` holds
 * back every date a named kitchen delivered on, so the rest of the history can
 * land while one rate is still being confirmed.
 *
 * Run: pnpm tsx --env-file=.env.local scripts/replay-accruals.ts [--apply]
 *      [--skip-kitchen=<uuid>] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 */
import { accrueDeliveryDate } from "@/lib/accounting/accrue-deliveries";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { jakartaDateString } from "@/lib/menu/week";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=")[1];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();
  const today = jakartaDateString();
  const from = arg("from") ?? "2000-01-01";
  const to = arg("to") ?? today;
  const skipKitchen = arg("skip-kitchen");

  const { rows, error } = await fetchAllRows<{
    delivery_date: string;
    portions: number | null;
    subcontractor_id: string | null;
  }>((f, t) =>
    db
      .from("daily_deliveries")
      .select("delivery_date, portions, subcontractor_id")
      .gte("delivery_date", from)
      .lte("delivery_date", to)
      .order("delivery_date")
      .range(f, t),
  );
  if (error) {
    console.error("read failed:", error);
    process.exit(1);
  }

  const held = new Set<string>();
  if (skipKitchen) {
    for (const r of rows) {
      if (r.subcontractor_id === skipKitchen) held.add(r.delivery_date);
    }
  }
  const dates = [...new Set(rows.map((r) => r.delivery_date))]
    .filter((d) => !held.has(d))
    .sort();

  console.log(
    `${rows.length} rows over ${dates.length + held.size} dates (${from} .. ${to})`,
  );
  if (held.size) {
    console.log(`holding back ${held.size} dates: ${[...held].sort().join(", ")}`);
  }
  if (!apply) {
    console.log("\ndry run — pass --apply to post");
    return;
  }

  let revenue = 0;
  let cogs = 0;
  let ongkir = 0;
  let touched = 0;
  const byMonth = new Map<string, { rev: number; cogs: number }>();

  for (const date of dates) {
    const res = await accrueDeliveryDate(db, date);
    if (res.revenue || res.cogs || res.ongkir) {
      touched++;
      const m = date.slice(0, 7);
      const acc = byMonth.get(m) ?? { rev: 0, cogs: 0 };
      acc.rev += res.revenue;
      acc.cogs += res.cogs;
      byMonth.set(m, acc);
    }
    revenue += res.revenue;
    cogs += res.cogs;
    ongkir += res.ongkir;
  }

  console.log(`\nposted on ${touched} of ${dates.length} dates:`);
  for (const [m, v] of [...byMonth.entries()].sort()) {
    console.log(
      `  ${m}  revenue Rp ${v.rev.toLocaleString("id-ID").padStart(12)}   COGS Rp ${v.cogs.toLocaleString("id-ID").padStart(12)}`,
    );
  }
  console.log(`\n  revenue Rp ${revenue.toLocaleString("id-ID")}`);
  console.log(`  COGS    Rp ${cogs.toLocaleString("id-ID")}`);
  console.log(`  ongkir  Rp ${ongkir.toLocaleString("id-ID")}`);
  if (revenue > 0) {
    console.log(
      `  gross margin ${(((revenue - cogs) / revenue) * 100).toFixed(1)}%`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
