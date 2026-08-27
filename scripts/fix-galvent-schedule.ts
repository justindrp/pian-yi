/**
 * galvent booked tomorrow only ("Bsk mao ... Nanti selanjutny diinfo per 1 hari
 * sblomnya bs kan nk") — a per-day customer. His 10-porsi order was created with
 * a standing dinner pattern, so five days were generated at 2 porsi each and the
 * package read as fully spent on the day it was bought.
 */
import { createAdminClient } from "../src/lib/supabase/admin";

const ORDER = "ce3f8431-24fa-48cb-8645-01dcadc5926e";
const KEEP = "2026-08-20";

async function main() {
  const db = createAdminClient();
  const { data: dels } = await db
    .from("daily_deliveries")
    .select("id, delivery_date, portions")
    .eq("order_id", ORDER)
    .order("delivery_date");
  const drop = (dels ?? []).filter((d) => d.delivery_date !== KEEP);
  for (const d of drop) {
    await db.from("daily_deliveries").delete().eq("id", d.id);
    console.log(`dropped ${d.delivery_date} x${d.portions}`);
  }
  const kept = (dels ?? []).filter((d) => d.delivery_date === KEEP);
  const drawn = kept.reduce((n, d) => n + (d.portions ?? 0), 0);
  await db
    .from("orders")
    .update({
      // Per-day decision: auto-generation deliberately skips these, so nothing
      // will refill the week he never asked for.
      meal_time_preference: "per_day_decision",
      end_date: null,
    })
    .eq("id", ORDER);
  console.log(`order set to per_day_decision, ${10 - drawn} porsi left`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
