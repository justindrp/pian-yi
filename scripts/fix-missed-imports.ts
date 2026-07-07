/**
 * Creates completed historical orders for customers whose pre-Jun-29 sheet
 * purchases were never imported (import script missed them entirely).
 * Their in-app orders (Jun 29+) remain untouched.
 *
 * Run:
 *   pnpm tsx scripts/fix-missed-imports.ts          # dry run
 *   pnpm tsx scripts/fix-missed-imports.ts --apply
 */

import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const dryRun = !process.argv.includes('--apply');

const FIXES: { name: string; purchases: { date: string; porsi: number; price: number; total: number }[] }[] = [
  {
    name: 'Vanessa',
    purchases: [
      { date: '2026-04-15', porsi: 35, price: 20000, total: 700000 },
      { date: '2026-04-24', porsi: 3,  price: 20000, total: 60000  },
    ],
  },
  {
    name: 'Jocelyn',
    purchases: [
      { date: '2025-12-02', porsi: 5, price: 27000, total: 135000 },
      { date: '2025-12-07', porsi: 7, price: 27000, total: 189000 },
    ],
  },
  {
    name: 'Sensen',
    purchases: [
      { date: '2025-12-09', porsi: 5, price: 27000, total: 135000 },
      { date: '2025-12-10', porsi: 1, price: 25000, total: 25000  },
    ],
  },
  {
    name: 'Monica',
    purchases: [
      { date: '2026-06-27', porsi: 10, price: 28000, total: 280000 }, // Jul 2 in-app stays
    ],
  },
];

async function main() {
  console.log(`\n=== fix-missed-imports (${dryRun ? 'DRY RUN' : 'APPLYING'}) ===\n`);

  const { data: allCustomers } = await db.from('customers').select('id, name');
  const custMap = new Map(allCustomers?.map(c => [c.name?.toLowerCase().trim(), c.id]) ?? []);

  const { data: allOrders } = await db.from('orders')
    .select('id, customer_id, subcontractor_id, meal_time_preference, portions_per_delivery')
    .order('created_at');

  for (const fix of FIXES) {
    const custId = custMap.get(fix.name.toLowerCase().trim());
    if (!custId) { console.log(`${fix.name}: customer not found — skip`); continue; }

    // Use any existing order as template for subcontractor/meal_time fields
    const anyOrder = allOrders?.find(o => o.customer_id === custId);

    console.log(`\n─── ${fix.name} ───`);
    for (const p of fix.purchases) {
      console.log(`  + Create completed: ${p.date}, ${p.porsi}p @ ${p.price}/p = Rp${p.total.toLocaleString('id-ID')}`);
      if (!dryRun) {
        const { error } = await db.from('orders').insert({
          customer_id: custId,
          subcontractor_id: anyOrder?.subcontractor_id ?? null,
          status: 'completed',
          package_size: p.porsi,
          portions_remaining: 0,
          price_per_portion: p.price,
          total_price: p.total,
          meal_time_preference: anyOrder?.meal_time_preference ?? 'per_day_decision',
          portions_per_delivery: anyOrder?.portions_per_delivery ?? 1,
          start_date: p.date,
        });
        if (error) console.error(`    ERROR: ${error.message}`);
      }
    }
  }

  console.log('\nDone.');
}

main().catch(console.error);
