/**
 * Creates orders from scratch for customers who have sheet purchases
 * but zero DB orders (import script missed them entirely).
 *
 * Older purchases → completed (portions_remaining=0)
 * Most recent → active (portions_remaining=package_size)
 *
 * Run:
 *   pnpm tsx scripts/fix-no-orders.ts          # dry run
 *   pnpm tsx scripts/fix-no-orders.ts --apply
 */

import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const dryRun = !process.argv.includes('--apply');

const FIXES: { name: string; purchases: { date: string; porsi: number; price: number; total: number }[] }[] = [
  {
    name: 'Defi Lugito',
    purchases: [
      { date: '2026-03-27', porsi: 20, price: 26000, total: 520000  },
      { date: '2026-04-09', porsi: 40, price: 25000, total: 1000000 },
      { date: '2026-05-18', porsi: 40, price: 25000, total: 1000000 }, // most recent → active
    ],
  },
  {
    name: 'Valen',
    purchases: [
      { date: '2026-05-03', porsi: 5,  price: 28000, total: 140000  },
      { date: '2026-05-08', porsi: 40, price: 25000, total: 1000000 }, // most recent → active
    ],
  },
  {
    name: 'Hanna',
    purchases: [
      { date: '2026-05-04', porsi: 10, price: 27000, total: 270000 },
      { date: '2026-05-15', porsi: 5,  price: 28000, total: 140000 },
      { date: '2026-05-22', porsi: 5,  price: 28000, total: 140000 },
      { date: '2026-06-09', porsi: 10, price: 28000, total: 280000 },
      { date: '2026-06-29', porsi: 10, price: 28000, total: 280000 }, // most recent → active
    ],
  },
];

async function main() {
  console.log(`\n=== fix-no-orders (${dryRun ? 'DRY RUN' : 'APPLYING'}) ===\n`);

  const { data: allCustomers } = await db.from('customers').select('id, name');
  const custMap = new Map(allCustomers?.map(c => [c.name?.toLowerCase().trim(), c.id]) ?? []);

  for (const fix of FIXES) {
    const custId = custMap.get(fix.name.toLowerCase().trim());
    if (!custId) { console.log(`${fix.name}: customer not found — skip`); continue; }

    // Verify no orders exist
    const { count } = await db.from('orders').select('id', { count: 'exact', head: true }).eq('customer_id', custId);
    if ((count ?? 0) > 0) {
      console.log(`${fix.name}: already has ${count} order(s) — skip to avoid duplicates`);
      continue;
    }

    console.log(`\n─── ${fix.name} ───`);
    for (let i = 0; i < fix.purchases.length; i++) {
      const p = fix.purchases[i];
      const isLast = i === fix.purchases.length - 1;
      const status = isLast ? 'active' : 'completed';
      const remaining = isLast ? p.porsi : 0;
      console.log(`  + Create ${status}: ${p.date}, ${p.porsi}p @ ${p.price}/p = Rp${p.total.toLocaleString('id-ID')}${isLast ? ' (active)' : ''}`);
      if (!dryRun) {
        const { error } = await db.from('orders').insert({
          customer_id: custId,
          status,
          package_size: p.porsi,
          portions_remaining: remaining,
          price_per_portion: p.price,
          total_price: p.total,
          meal_time_preference: 'per_day_decision',
          portions_per_delivery: 1,
          start_date: p.date,
        });
        if (error) console.error(`    ERROR: ${error.message}`);
      }
    }
  }

  console.log('\nDone.');
}

main().catch(console.error);
