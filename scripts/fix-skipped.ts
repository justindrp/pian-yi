/**
 * Second-pass fix for the 6 customers skipped by fix-imported-order-dates.ts.
 * Tia's Jun 30 in-app order (Jun 29 purchase) stays untouched.
 *
 * Run:
 *   pnpm tsx scripts/fix-skipped.ts          # dry run
 *   pnpm tsx scripts/fix-skipped.ts --apply
 */

import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const dryRun = !process.argv.includes('--apply');

interface Purchase {
  date: string;
  porsi: number;
  price: number;
  total: number;
}

const FIXES: { name: string; custId: string; importOrderId: string; deleteOrderIds: string[]; purchases: Purchase[] }[] = [
  {
    name: 'Keren Hana',
    custId: '', // filled below
    importOrderId: '', // filled below
    deleteOrderIds: [], // filled below
    purchases: [
      { date: '2025-12-01', porsi: 2, price: 28000, total: 56000 },
      { date: '2025-12-08', porsi: 2, price: 28000, total: 56000 },
      { date: '2025-12-16', porsi: 3, price: 28000, total: 84000 },
      { date: '2025-12-25', porsi: 1, price: 29000, total: 29000 },
      { date: '2026-01-07', porsi: 2, price: 28000, total: 56000 }, // last
    ],
  },
  {
    name: 'Nabila',
    custId: '',
    importOrderId: '',
    deleteOrderIds: [],
    purchases: [
      { date: '2025-12-02', porsi: 20, price: 25000, total: 500000 },
      { date: '2026-01-30', porsi: 20, price: 25000, total: 500000 },
      { date: '2026-03-01', porsi: 10, price: 27000, total: 270000 },
      { date: '2026-04-06', porsi: 20, price: 26000, total: 520000 },
      { date: '2026-06-01', porsi: 40, price: 25000, total: 1000000 }, // last
    ],
  },
  {
    name: 'Charloz',
    custId: '',
    importOrderId: '',
    deleteOrderIds: [],
    purchases: [
      { date: '2025-12-05', porsi: 10, price: 26000, total: 260000 },
      { date: '2025-12-11', porsi: 10, price: 26000, total: 260000 },
      { date: '2025-12-18', porsi: 10, price: 26000, total: 260000 }, // last
    ],
  },
  {
    name: 'Wendy',
    custId: '',
    importOrderId: '',
    deleteOrderIds: [],
    purchases: [
      { date: '2025-12-07', porsi: 10, price: 26000, total: 260000 },
      { date: '2025-12-17', porsi: 10, price: 26000, total: 260000 }, // last
    ],
  },
  {
    name: 'Nicholas Satria',
    custId: '',
    importOrderId: '',
    deleteOrderIds: [], // the 1p ghost (no deliveries) — filled below
    purchases: [
      { date: '2026-05-03', porsi: 10, price: 27000, total: 270000 },
      { date: '2026-06-04', porsi: 10, price: 28000, total: 280000 }, // last
    ],
  },
  {
    name: 'Tia',
    custId: '',
    importOrderId: '',
    deleteOrderIds: [],
    purchases: [
      { date: '2026-05-10', porsi: 10, price: 27000, total: 270000 },
      { date: '2026-05-17', porsi: 10, price: 27000, total: 270000 },
      { date: '2026-05-31', porsi: 10, price: 28000, total: 280000 },
      { date: '2026-06-06', porsi: 12, price: 28000, total: 336000 },
      { date: '2026-06-16', porsi: 5, price: 29000, total: 145000 },
      { date: '2026-06-20', porsi: 2, price: 30000, total: 60000 }, // last (Jun 29 in-app = separate order)
    ],
  },
];

async function main() {
  console.log(`\n=== fix-skipped (${dryRun ? 'DRY RUN' : 'APPLYING'}) ===\n`);

  // Resolve customer IDs and import order IDs from DB
  const { data: allCustomers } = await db.from('customers').select('id, name');
  const custMap = new Map(allCustomers?.map(c => [c.name?.toLowerCase().trim(), c.id]) ?? []);

  const { data: allOrders } = await db.from('orders')
    .select('id, customer_id, package_size, portions_remaining, price_per_portion, start_date, created_at, meal_time_preference, portions_per_delivery, subcontractor_id')
    .order('created_at');

  for (const fix of FIXES) {
    const custId = custMap.get(fix.name.toLowerCase().trim());
    if (!custId) { console.log(`${fix.name}: customer not found — skip`); continue; }
    fix.custId = custId;

    const orders = allOrders?.filter(o => o.customer_id === custId) ?? [];
    const importOrders = orders.filter(o => o.created_at?.startsWith('2026-06-08') && !isJunk(o));
    const junkOrders = orders.filter(o => isJunk(o));

    if (fix.name === 'Nicholas Satria') {
      // 2 import orders: keep the one with deliveries, delete the ghost (no deliveries)
      if (importOrders.length !== 2) { console.log(`${fix.name}: expected 2 import orders, found ${importOrders.length} — skip`); continue; }
      for (const o of importOrders) {
        const { count } = await db.from('daily_deliveries').select('id', { count: 'exact', head: true }).eq('order_id', o.id);
        if ((count ?? 0) === 0) fix.deleteOrderIds.push(o.id);
        else fix.importOrderId = o.id;
      }
    } else {
      if (importOrders.length !== 1) { console.log(`${fix.name}: expected 1 import order, found ${importOrders.length} — skip`); continue; }
      fix.importOrderId = importOrders[0].id;
      for (const junk of junkOrders) {
        const { count } = await db.from('daily_deliveries').select('id', { count: 'exact', head: true }).eq('order_id', junk.id);
        if ((count ?? 0) === 0) fix.deleteOrderIds.push(junk.id);
        else console.log(`  ⚠ ${fix.name}: junk order ${junk.id} has ${count} deliveries — not deleting`);
      }
    }

    const baseOrder = orders.find(o => o.id === fix.importOrderId);
    if (!baseOrder) { console.log(`${fix.name}: could not resolve import order — skip`); continue; }

    const lastPurchase = fix.purchases[fix.purchases.length - 1];
    const olderPurchases = fix.purchases.slice(0, -1);

    console.log(`\n─── ${fix.name} ───`);

    // Delete junk / ghost orders
    for (const id of fix.deleteOrderIds) {
      console.log(`  🗑 Delete order ${id}`);
      if (!dryRun) {
        const { error } = await db.from('orders').delete().eq('id', id);
        if (error) console.error(`    ERROR: ${error.message}`);
      }
    }

    // Create completed orders for older purchases
    for (const p of olderPurchases) {
      console.log(`  + Create completed: ${p.date}, ${p.porsi}p @ ${p.price}/p = Rp${p.total.toLocaleString('id-ID')}`);
      if (!dryRun) {
        const { error } = await db.from('orders').insert({
          customer_id: custId,
          subcontractor_id: baseOrder.subcontractor_id,
          status: 'completed',
          package_size: p.porsi,
          portions_remaining: 0,
          price_per_portion: p.price,
          total_price: p.total,
          meal_time_preference: baseOrder.meal_time_preference || 'per_day_decision',
          portions_per_delivery: baseOrder.portions_per_delivery || 1,
          start_date: p.date,
        });
        if (error) console.error(`    ERROR: ${error.message}`);
      }
    }

    // Update import order to last purchase
    console.log(`  ✎ Update import order ${fix.importOrderId} → ${lastPurchase.date}, ${lastPurchase.porsi}p @ ${lastPurchase.price}/p`);
    if (!dryRun) {
      const { error } = await db.from('orders').update({
        start_date: lastPurchase.date,
        package_size: lastPurchase.porsi,
        price_per_portion: lastPurchase.price,
        total_price: lastPurchase.total,
      }).eq('id', fix.importOrderId);
      if (error) console.error(`    ERROR: ${error.message}`);
    }
  }

  console.log('\nDone.');
}

function isJunk(o: { package_size: number | null; portions_remaining: number | null }): boolean {
  return (o.package_size ?? 0) === 0 && (o.portions_remaining ?? 0) === 0;
}

main().catch(console.error);
