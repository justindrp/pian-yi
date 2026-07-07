/**
 * Moves Hanna's orders from the duplicate customer (6285174104007, no + sign)
 * to the correct customer (+6285174104007), then deletes the duplicate.
 *
 * Run:
 *   pnpm tsx scripts/fix-hanna-duplicate.ts          # dry run
 *   pnpm tsx scripts/fix-hanna-duplicate.ts --apply
 */

import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const dryRun = !process.argv.includes('--apply');

async function main() {
  console.log(`\n=== fix-hanna-duplicate (${dryRun ? 'DRY RUN' : 'APPLYING'}) ===\n`);

  const { data: hannas } = await db.from('customers')
    .select('id, name, phone_number, area')
    .ilike('name', '%hanna%');

  console.log('Found Hanna rows:');
  for (const h of hannas ?? []) console.log(`  ${h.id} | ${h.phone_number} | area=${h.area}`);

  const correct = hannas?.find(h => h.phone_number === '+6285174104007');
  const duplicate = hannas?.find(h => h.phone_number === '6285174104007');

  if (!correct) throw new Error('Correct Hanna (+6285174104007) not found');
  if (!duplicate) throw new Error('Duplicate Hanna (6285174104007) not found');

  console.log(`\nCorrect:   ${correct.id} (${correct.phone_number})`);
  console.log(`Duplicate: ${duplicate.id} (${duplicate.phone_number})`);

  // Show orders on duplicate
  const { data: dupOrders } = await db.from('orders')
    .select('id, start_date, package_size, price_per_portion, status')
    .eq('customer_id', duplicate.id);

  console.log(`\nOrders on duplicate (${dupOrders?.length ?? 0}):`);
  for (const o of dupOrders ?? []) {
    console.log(`  ${o.id} | ${o.start_date} | ${o.package_size}p @ ${o.price_per_portion} | ${o.status}`);
  }

  if (!dryRun) {
    // 1. Move orders to correct customer
    if (dupOrders?.length) {
      const { error } = await db.from('orders')
        .update({ customer_id: correct.id })
        .eq('customer_id', duplicate.id);
      if (error) throw new Error(`Move orders failed: ${error.message}`);
      console.log(`\nMoved ${dupOrders.length} order(s) to correct Hanna`);
    }

    // 2. Delete duplicate customer (check for daily_deliveries/other refs first)
    const { count: delivCount } = await db.from('daily_deliveries')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', duplicate.id);
    if ((delivCount ?? 0) > 0) {
      const { error } = await db.from('daily_deliveries')
        .update({ customer_id: correct.id })
        .eq('customer_id', duplicate.id);
      if (error) throw new Error(`Move deliveries failed: ${error.message}`);
      console.log(`Moved ${delivCount} delivery row(s) to correct Hanna`);
    }

    const { error: delErr } = await db.from('customers').delete().eq('id', duplicate.id);
    if (delErr) throw new Error(`Delete duplicate failed: ${delErr.message}`);
    console.log(`Deleted duplicate customer ${duplicate.id}`);
  } else {
    console.log(`\n[dry run] Would move ${dupOrders?.length ?? 0} orders → correct Hanna`);
    console.log('[dry run] Would delete duplicate customer');
  }
}

main().catch(console.error);
