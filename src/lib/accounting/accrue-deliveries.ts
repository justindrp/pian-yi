import type { SupabaseClient } from "@supabase/supabase-js";
import { createJournalEntry } from "@/lib/accounting/journal";
import {
  kitchenCostPerPortion,
  normalizeSize,
  type OrderSize,
} from "@/lib/orders/size";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/**
 * Recognises one delivery day into the books: revenue, COGS, and the ongkir
 * that moves from held to owed.
 *
 * This used to live inside `PUT /api/deliveries/daily-sheet` and ran off the
 * payload that route was handed, which meant the books were a side effect of
 * an admin pressing Save on the Deliveries page. Rows also arrive from the bot
 * (`record_daily_order`, `mark_paid`) and from order creation, and none of
 * those paths touch that button — so when the humans stopped saving sheets on
 * **21 Agustus 2026** revenue recognition and kitchen cost accrual both stopped
 * with them, silently, for three weeks. Nothing was wrong on any screen: the
 * deliveries were cooked, the orders were paid, and the ledger simply did not
 * hear about any of it.
 *
 * So the accrual reads `daily_deliveries` instead. A delivery row means the
 * food is cooked and delivered (migration 075) and that is exactly the event
 * being recognised, which makes the rows the only honest source. The daily
 * cron (`/api/cron/accrue-deliveries`) walks the recent past with it; the Save
 * button still calls it too, so a sheet edited by hand posts immediately
 * rather than waiting for the night.
 *
 * Idempotent on the same `rev_` / `cogs_` / `ongkir_` source keys the old
 * inline version used, so re-running it over an already-posted date writes
 * nothing and the historic journals are not duplicated. The totals it returns
 * are what this call posted, not what the date is worth — a re-walk of a
 * settled day returns zeroes.
 *
 * The flip side of that key: a journal already posted for a date is **not**
 * rewritten when the sheet changes afterwards. That was true of the inline
 * version too. A day corrected after its journal exists needs a manual
 * adjusting entry, which is what an adjusting entry is for.
 */
export async function accrueDeliveryDate(
  db: Db,
  date: string,
): Promise<{ revenue: number; cogs: number; ongkir: number }> {
  const { data: rows, error } = await db
    .from("daily_deliveries")
    .select(
      "meal_type, portions, price_per_portion, subcontractor_id, customer_id, customers(delivery_route), orders(price_per_portion, addon_cost_per_portion, size, delivery_surcharge_per_delivery)",
    )
    .eq("delivery_date", date);

  if (error) {
    console.error("[accrual] failed to read deliveries:", error.message);
    return { revenue: 0, cogs: 0, ongkir: 0 };
  }
  if (!rows?.length) return { revenue: 0, cogs: 0, ongkir: 0 };

  const { data: rawSubs } = await db
    .from("subcontractors")
    .select(
      "id, cost_per_portion, cost_per_portion_route1, cost_per_portion_m, cost_per_portion_route1_m",
    );
  const subRateMap = new Map((rawSubs ?? []).map((s) => [s.id, s] as const));

  type Entry = {
    portions: number;
    pricePerPortion: number;
    addonCostPerPortion: number;
    surchargePerDelivery: number;
    subcontractorId: string | null;
    route: 1 | 2;
    size: OrderSize;
  };
  const byMeal = new Map<string, Entry[]>();

  for (const row of rows) {
    const ord = row.orders as {
      price_per_portion: number | null;
      addon_cost_per_portion: number | null;
      size: string | null;
      delivery_surcharge_per_delivery: number | null;
    } | null;
    // A row with no order behind it is not revenue: nobody bought it. The
    // daily sheet refuses to save one, but rows predating that check exist.
    if (!ord?.price_per_portion) continue;
    const cust = row.customers as { delivery_route: string | null } | null;

    const entries = byMeal.get(row.meal_type) ?? [];
    if (entries.length === 0) byMeal.set(row.meal_type, entries);
    entries.push({
      portions: row.portions ?? 0,
      // The row's own rate wins. It is set only when this delivery is cooked
      // by a kitchen the order was not bought from, and then the order's rate
      // is the wrong one: revenue recognition draws 2100 down by portions ×
      // rate, and the deposit was taken at the mix.
      pricePerPortion: row.price_per_portion ?? ord.price_per_portion,
      addonCostPerPortion: ord.addon_cost_per_portion ?? 0,
      surchargePerDelivery: ord.delivery_surcharge_per_delivery ?? 0,
      subcontractorId: row.subcontractor_id,
      route: cust?.delivery_route === "1" ? 1 : 2,
      size: normalizeSize(ord.size),
    });
  }

  let revenue = 0;
  let cogs = 0;
  let ongkir = 0;

  for (const [mealType, entries] of byMeal.entries()) {
    // Revenue: grouped by price_per_portion, because one day holds several
    // tiers and a contract rate, and the note has to show the arithmetic.
    const revenueByRate = new Map<number, number>();
    for (const e of entries) {
      revenueByRate.set(
        e.pricePerPortion,
        (revenueByRate.get(e.pricePerPortion) ?? 0) + e.portions,
      );
    }
    const totalRevenue = [...revenueByRate.entries()].reduce(
      (s, [price, p]) => s + price * p,
      0,
    );
    if (totalRevenue > 0) {
      const totalPortions = entries.reduce((s, e) => s + e.portions, 0);
      const revParts = [...revenueByRate.entries()]
        .sort(([a], [b]) => a - b)
        .map(([price, p]) => `${p}p × Rp${price.toLocaleString("id-ID")}`);
      const res = await createJournalEntry({
        description: `Revenue recognition ${date} ${mealType}`,
        date,
        sourceType: "delivery",
        sourceId: `rev_${date}_${mealType}`,
        notes: `${totalPortions} porsi: ${revParts.join(", ")} = Rp${totalRevenue.toLocaleString("id-ID")}`,
        lines: [
          { accountCode: "2100", debit: totalRevenue, credit: 0 },
          { accountCode: "4001", debit: 0, credit: totalRevenue },
        ],
      });
      if (res?.created) revenue += totalRevenue;
    }

    // COGS: grouped by effective cost per portion. M is a second dish the
    // kitchen bills us for and carries its own pair of route rates, so costing
    // an M portion at the S rate reports a margin wider than it is.
    const cogsByRate = new Map<number, number>();
    for (const e of entries) {
      const sub = e.subcontractorId
        ? subRateMap.get(e.subcontractorId)
        : undefined;
      const subCost = sub ? kitchenCostPerPortion(sub, e.size, e.route) : 0;
      const totalRate = subCost + e.addonCostPerPortion;
      if (totalRate > 0) {
        cogsByRate.set(
          totalRate,
          (cogsByRate.get(totalRate) ?? 0) + e.portions,
        );
      }
    }
    const totalCogs = [...cogsByRate.entries()].reduce(
      (s, [rate, p]) => s + rate * p,
      0,
    );
    if (totalCogs > 0) {
      const totalCogsPortions = [...cogsByRate.values()].reduce(
        (s, p) => s + p,
        0,
      );
      const cogsParts = [...cogsByRate.entries()]
        .sort(([a], [b]) => a - b)
        .map(([rate, p]) => `${p}p × Rp${rate.toLocaleString("id-ID")}`);
      const res = await createJournalEntry({
        description: `COGS ${date} ${mealType}`,
        date,
        sourceType: "delivery_cogs",
        sourceId: `cogs_${date}_${mealType}`,
        notes: `${totalCogsPortions} porsi: ${cogsParts.join(", ")} = Rp${totalCogs.toLocaleString("id-ID")}`,
        lines: [
          { accountCode: "5001", debit: totalCogs, credit: 0 },
          { accountCode: "2001", debit: 0, credit: totalCogs },
        ],
      });
      if (res?.created) cogs += totalCogs;
    }

    // Ongkir is a pass-through, never revenue: we collect Rp 10.000 a drop
    // from a customer in a surcharged neighbourhood and owe the kitchen the
    // same Rp 10.000 for driving there. It is held as 2101 Unearned Delivery
    // Fee when the customer pays and moves to 2001 Accounts Payable here.
    // Counted in **drops, not portions**: three portions to one door is one
    // fee, and `entries` holds one element per delivery row, which is one drop.
    const ongkirDrops = entries.filter((e) => e.surchargePerDelivery > 0);
    const totalOngkir = ongkirDrops.reduce(
      (s, e) => s + e.surchargePerDelivery,
      0,
    );
    if (totalOngkir > 0) {
      const ongkirByRate = new Map<number, number>();
      for (const e of ongkirDrops) {
        ongkirByRate.set(
          e.surchargePerDelivery,
          (ongkirByRate.get(e.surchargePerDelivery) ?? 0) + 1,
        );
      }
      const ongkirParts = [...ongkirByRate.entries()]
        .sort(([a], [b]) => a - b)
        .map(
          ([rate, drops]) =>
            `${drops} drop × Rp${rate.toLocaleString("id-ID")}`,
        );
      const res = await createJournalEntry({
        description: `Ongkir terutang ke dapur ${date} ${mealType}`,
        date,
        sourceType: "delivery_ongkir",
        sourceId: `ongkir_${date}_${mealType}`,
        notes: `${ongkirParts.join(", ")} = Rp${totalOngkir.toLocaleString("id-ID")}`,
        lines: [
          { accountCode: "2101", debit: totalOngkir, credit: 0 },
          { accountCode: "2001", debit: 0, credit: totalOngkir },
        ],
      });
      if (res?.created) ongkir += totalOngkir;
    }
  }

  return { revenue, cogs, ongkir };
}
