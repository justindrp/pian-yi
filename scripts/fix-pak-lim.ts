import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const { data: cust } = await db.from('customers').select('id').ilike('name', '%pak lim%').single();
  if (!cust) throw new Error('Pak Lim not found');

  const { data: orders } = await db.from('orders')
    .select('id, package_size, portions_remaining, created_at')
    .eq('customer_id', cust.id)
    .order('created_at');

  console.log('Orders:', JSON.stringify(orders, null, 2));

  // The Jun 8 import order (56p = 40 meal + 16 rice addon merged)
  const importOrder = orders?.find(o => o.created_at?.startsWith('2026-06-08'));
  if (!importOrder) throw new Error('Import order not found');

  // May 27: 40 meal portions @ 25000/p = 1,000,000
  // Jun 5: 16 rice @ 2000/each = 32,000 → addon_cost_per_portion = 32000/40 = 800/p
  const { error } = await db.from('orders').update({
    start_date: '2026-05-27',
    package_size: 40,
    price_per_portion: 25000,
    total_price: 1000000,
    addon_cost_per_portion: 800,
  }).eq('id', importOrder.id);

  if (error) throw error;
  console.log(`Updated order ${importOrder.id}: May 27, 40p @ 25000/p, addon_cost_per_portion=800`);
}

main().catch(console.error);
