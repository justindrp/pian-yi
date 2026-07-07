import { createClient } from '@supabase/supabase-js';

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: custs } = await db.from('customers').select('id, name, portions_remaining, avg_price_per_portion').ilike('name', '%febby%');
  console.log('Customer:', JSON.stringify(custs?.[0], null, 2));

  if (custs?.length) {
    const { data: orders } = await db.from('orders')
      .select('id, status, package_size, portions_remaining, price_per_portion, total_price, start_date, created_at')
      .eq('customer_id', custs[0].id)
      .order('start_date');
    console.log(`Orders (${orders?.length}):`, JSON.stringify(orders, null, 2));
  }
}

main().catch(console.error);
