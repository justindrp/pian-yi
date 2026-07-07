import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const SHEET_ID = '13cKpPcqdqXTpqWrWL5sDiZVNrYClzSBcrypO_CPZTgI';
const GID_PACKAGES = '341974326';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TARGETS = ['Keren Hana', 'Nabila', 'Charloz', 'Wendy', 'Pak Lim', 'Nicholas Satria', 'Tia'];

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
function digits(s: string): number { return parseInt(s.replace(/[^0-9]/g, ''), 10) || 0; }
function getCol(row: Record<string, string>, keys: string[]): string {
  for (const k of keys) for (const [h, v] of Object.entries(row)) if (h.toLowerCase() === k.toLowerCase()) return v;
  for (const k of keys) for (const [h, v] of Object.entries(row)) if (h.toLowerCase().includes(k.toLowerCase())) return v;
  return '';
}

async function main() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_PACKAGES}`;
  const res = await fetch(url);
  const rawRows = parse(await res.text(), { skip_empty_lines: false, relax_column_count: true, relax_quotes: true, trim: true }) as string[][];
  const headers = rawRows[0];
  const rows = rawRows.slice(1).filter(r => r.some(c => c.trim() !== ''));
  const records = rows.map(row => {
    const rec: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) rec[headers[i].trim()] = (row[i] ?? '').trim();
    return rec;
  });

  const byName = new Map<string, { date: string; porsi: number; price: number; total: number }[]>();
  for (const r of records) {
    const nama = getCol(r, ['nama', 'name']).trim();
    if (!TARGETS.some(t => t.toLowerCase() === nama.toLowerCase())) continue;
    const date = parseDate(getCol(r, ['tanggal', 'date']));
    if (!date) continue;
    const porsi = digits(getCol(r, ['porsi', 'portion']));
    const price = digits(getCol(r, ['price_per_portion', 'harga', 'price']));
    const total = digits(getCol(r, ['total']));
    if (porsi === 0 && total === 0) continue;
    if (!byName.has(nama)) byName.set(nama, []);
    byName.get(nama)!.push({ date, porsi, price, total });
  }
  for (const [, v] of byName) v.sort((a, b) => a.date.localeCompare(b.date));

  const { data: custs } = await db.from('customers').select('id, name, portions_remaining');
  const custMap = new Map(custs?.map(c => [c.name?.toLowerCase(), c]) ?? []);

  for (const name of TARGETS) {
    const cust = custMap.get(name.toLowerCase());
    const purchases = byName.get(name) ?? [];
    console.log(`\n=== ${name} ===`);
    console.log(`Sheet purchases (${purchases.length}):`);
    for (const p of purchases) console.log(`  ${p.date}: ${p.porsi}p @ ${p.price}/p = Rp${p.total.toLocaleString('id-ID')}`);

    if (!cust) { console.log('  DB: customer not found'); continue; }
    const { data: orders } = await db.from('orders')
      .select('id, status, package_size, portions_remaining, price_per_portion, total_price, start_date, created_at')
      .eq('customer_id', cust.id).order('created_at');
    console.log(`DB orders (${orders?.length ?? 0}):`);
    for (const o of orders ?? []) {
      const { count } = await db.from('daily_deliveries').select('id', { count: 'exact', head: true }).eq('order_id', o.id);
      console.log(`  ${o.start_date} (created ${o.created_at?.slice(0,10)}): ${o.package_size}p remaining=${o.portions_remaining} status=${o.status} deliveries=${count}`);
    }
  }
}

main().catch(console.error);
