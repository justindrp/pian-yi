/**
 * Finds customers in package_orders sheet who have multiple purchase rows
 * and checks their DB state.
 */
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const SHEET_ID = '13cKpPcqdqXTpqWrWL5sDiZVNrYClzSBcrypO_CPZTgI';
const GID_PACKAGES = '341974326';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const db = createClient(supabaseUrl, serviceRoleKey);

function parseDate(raw: string): string | null {
  if (!raw || raw === '#N/A') return null;
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) return raw.slice(0, 10);
  return null;
}

function digits(s: string): number {
  return parseInt(s.replace(/[^0-9]/g, ''), 10) || 0;
}

// Exact header match first, then substring fallback
function getCol(row: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    for (const [h, v] of Object.entries(row)) {
      if (h.toLowerCase() === k.toLowerCase()) return v;
    }
  }
  for (const k of keys) {
    for (const [h, v] of Object.entries(row)) {
      if (h.toLowerCase().includes(k.toLowerCase())) return v;
    }
  }
  return '';
}

async function main() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_PACKAGES}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);

  const rawRows = parse(await res.text(), {
    skip_empty_lines: false,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  }) as string[][];

  console.log('Sheet headers:', rawRows[0]);
  console.log('Sample row 2:', rawRows[1]);
  console.log('Sample row 3:', rawRows[2]);
  console.log();

  const headers = rawRows[0];
  const rows = rawRows.slice(1).filter(r => r.some(c => c.trim() !== ''));

  const records = rows.map(row => {
    const rec: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) rec[headers[i].trim()] = (row[i] ?? '').trim();
    return rec;
  });

  // Group by nama
  type Purchase = { date: string | null; porsi: number; price: number; total: number };
  const byName = new Map<string, Purchase[]>();
  for (const r of records) {
    const nama = getCol(r, ['nama', 'name']).trim();
    if (!nama || nama === '#N/A' || nama.toLowerCase() === 'nama') continue;

    const tanggal = getCol(r, ['tanggal', 'date']);
    const porsi = digits(getCol(r, ['porsi', 'portion']));
    const price = digits(getCol(r, ['harga', 'price']));
    const total = digits(getCol(r, ['total']));

    if (!byName.has(nama)) byName.set(nama, []);
    byName.get(nama)!.push({ date: parseDate(tanggal), porsi, price, total });
  }

  // Show Febby specifically to debug
  const febby = byName.get('Febby');
  console.log('Febby purchases:', JSON.stringify(febby, null, 2));
  console.log();

  // Find customers with multiple purchases
  const multiPurchase = [...byName.entries()]
    .filter(([, purchases]) => purchases.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`Customers with multiple package_orders rows: ${multiPurchase.length}\n`);

  // Load DB customers + their orders
  const { data: dbCustomers } = await db.from('customers').select('id, name, portions_remaining');
  const custByNameLower = new Map<string, { id: string; name: string; portions_remaining: number | null }>();
  for (const c of dbCustomers ?? []) {
    if (c.name) custByNameLower.set(c.name.toLowerCase(), c);
  }

  for (const [sheetName, purchases] of multiPurchase) {
    const dbCust = custByNameLower.get(sheetName.toLowerCase());
    const custId = dbCust?.id;

    let dbOrders: any[] = [];
    if (custId) {
      const { data } = await db.from('orders').select('id, status, package_size, portions_remaining, price_per_portion, total_price, start_date, created_at')
        .eq('customer_id', custId)
        .order('created_at');
      dbOrders = data ?? [];
    }

    const totalPortions = purchases.reduce((s, p) => s + p.porsi, 0);
    const totalPrice = purchases.reduce((s, p) => s + p.total, 0);

    console.log(`${sheetName}`);
    console.log(`  Sheet: ${purchases.length} purchases, total ${totalPortions}p, Rp${totalPrice.toLocaleString('id-ID')}`);
    for (const p of purchases) {
      console.log(`    - ${p.date}: ${p.porsi}p @ ${p.price}/p = Rp${p.total.toLocaleString('id-ID')}`);
    }
    if (dbOrders.length === 0) {
      console.log(`  DB: no orders${dbCust ? '' : ' (customer not found)'}`);
    } else {
      console.log(`  DB: ${dbOrders.length} order(s)`);
      for (const o of dbOrders) {
        console.log(`    - ${o.start_date} (created ${o.created_at?.slice(0, 10)}): ${o.package_size}p @ ${o.price_per_portion}/p, remaining=${o.portions_remaining}, status=${o.status}`);
      }
    }
    console.log();
  }
}

main().catch(console.error);
