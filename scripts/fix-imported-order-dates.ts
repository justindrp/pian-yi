/**
 * Fix imported orders: splits merged multi-purchase orders into individual orders.
 *
 * Problem: the import script merged all package_orders purchases per customer into
 * one combined order with start_date = import date (2026-06-08). The correct behavior
 * is one DB order per purchase, each with the actual purchase date and amount.
 *
 * Strategy per customer with N>1 purchases:
 *   1. Delete junk zero-portion Jun-24 orders (second import run artifacts)
 *   2. Create N-1 "completed" historical orders for purchases 1..N-1
 *   3. Update the existing import order to match the most recent (Nth) purchase
 *      (start_date, package_size, price_per_portion, total_price — keep portions_remaining)
 *
 * daily_deliveries: left linked to the existing order (now represents last purchase).
 *
 * Run:
 *   pnpm tsx scripts/fix-imported-order-dates.ts          # dry run
 *   pnpm tsx scripts/fix-imported-order-dates.ts --apply  # apply changes
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

const dryRun = !process.argv.includes('--apply');

// ─── helpers ────────────────────────────────────────────────────────────────

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

// ─── types ──────────────────────────────────────────────────────────────────

interface Purchase {
  date: string;   // YYYY-MM-DD
  porsi: number;
  price: number;
  total: number;
}

interface DbOrder {
  id: string;
  status: string;
  package_size: number;
  portions_remaining: number;
  price_per_portion: number;
  total_price: number;
  start_date: string;
  created_at: string;
  customer_id: string;
  subcontractor_id: string | null;
  meal_time_preference: string;
  portions_per_delivery: number;
}

// ─── load sheet ─────────────────────────────────────────────────────────────

async function loadPurchases(): Promise<Map<string, Purchase[]>> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_PACKAGES}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);

  const rawRows = parse(await res.text(), {
    skip_empty_lines: false,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  }) as string[][];

  const headers = rawRows[0];
  const rows = rawRows.slice(1).filter(r => r.some(c => c.trim() !== ''));
  const records = rows.map(row => {
    const rec: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) rec[headers[i].trim()] = (row[i] ?? '').trim();
    return rec;
  });

  const byName = new Map<string, Purchase[]>();
  for (const r of records) {
    const nama = getCol(r, ['nama', 'name']).trim();
    if (!nama || nama === '#N/A' || nama.toLowerCase() === 'nama') continue;
    const date = parseDate(getCol(r, ['tanggal', 'date']));
    if (!date) continue;
    const porsi = digits(getCol(r, ['porsi', 'portion']));
    const price = digits(getCol(r, ['price_per_portion', 'harga', 'price']));
    const total = digits(getCol(r, ['total']));
    if (porsi === 0 && total === 0) continue; // empty row
    // Purchases from Jun 29 onward were entered in-app — exclude from import fix
    if (date >= '2026-06-29') continue;

    if (!byName.has(nama)) byName.set(nama, []);
    byName.get(nama)!.push({ date, porsi, price, total });
  }

  // Sort each customer's purchases by date
  for (const [, purchases] of byName) {
    purchases.sort((a, b) => a.date.localeCompare(b.date));
  }

  return byName;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== fix-imported-order-dates (${dryRun ? 'DRY RUN' : 'APPLYING'}) ===\n`);

  const purchasesByName = await loadPurchases();

  // Only process customers with multiple purchases
  const multiPurchase = [...purchasesByName.entries()].filter(([, p]) => p.length > 1);
  console.log(`Customers with N>1 purchases: ${multiPurchase.length}`);

  // Load all DB customers (name → id)
  const { data: dbCustomers } = await db.from('customers').select('id, name');
  const custByNameLower = new Map<string, { id: string; name: string }>();
  for (const c of dbCustomers ?? []) {
    if (c.name) custByNameLower.set(c.name.toLowerCase().trim(), c);
  }

  // Load all orders grouped by customer_id
  const { data: allOrders } = await db.from('orders').select(
    'id, customer_id, status, package_size, portions_remaining, price_per_portion, total_price, start_date, created_at, subcontractor_id, meal_time_preference, portions_per_delivery'
  ).order('created_at');

  const ordersByCust = new Map<string, DbOrder[]>();
  for (const o of allOrders ?? []) {
    if (!o.customer_id) continue;
    if (!ordersByCust.has(o.customer_id)) ordersByCust.set(o.customer_id, []);
    ordersByCust.get(o.customer_id)!.push(o as DbOrder);
  }

  const skipped: string[] = [];
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;

  for (const [sheetName, purchases] of multiPurchase) {
    const dbCust = custByNameLower.get(sheetName.toLowerCase().trim());
    if (!dbCust) {
      skipped.push(`${sheetName}: no DB customer match`);
      continue;
    }

    const orders = ordersByCust.get(dbCust.id) ?? [];

    // Classify orders:
    // - "import": created on 2026-06-08 (first import run)
    // - "junk": package_size=0 AND portions_remaining=0 AND price_per_portion=0 (second import artifact)
    // - "inapp": created after 2026-06-24 (in-app, authoritative, skip)
    const importOrders = orders.filter(o =>
      o.created_at.startsWith('2026-06-08') && !isJunk(o)
    );
    const junkOrders = orders.filter(o => isJunk(o));
    // In-app orders: created Jun 29 onward (before that = import artifacts)
    const inappOrders = orders.filter(o =>
      o.created_at >= '2026-06-29' && !isJunk(o)
    );

    // Skip customers with no import order (they were entered in-app correctly)
    if (importOrders.length === 0) {
      if (inappOrders.length > 0) {
        skipped.push(`${sheetName}: no import order — has ${inappOrders.length} in-app order(s), skipping`);
      } else {
        skipped.push(`${sheetName}: no orders at all`);
      }
      continue;
    }

    // Skip customers who also have in-app orders (complex, manual review)
    if (inappOrders.length > 0) {
      skipped.push(`${sheetName}: has ${inappOrders.length} in-app order(s) alongside import order — manual review needed`);
      continue;
    }

    // Only handle the case of exactly 1 import order (multi-import-order cases are complex)
    if (importOrders.length > 1) {
      skipped.push(`${sheetName}: ${importOrders.length} import orders — complex, manual review needed`);
      continue;
    }

    const existingOrder = importOrders[0];
    const lastPurchase = purchases[purchases.length - 1];
    const olderPurchases = purchases.slice(0, -1);

    // Safety check: remaining must not exceed last purchase size (operational sanity)
    // Note: completed orders (remaining=0) are always fine
    if (existingOrder.portions_remaining > lastPurchase.porsi && existingOrder.portions_remaining > 0) {
      skipped.push(
        `${sheetName}: remaining=${existingOrder.portions_remaining} > last_purchase=${lastPurchase.porsi} — balance spans multiple packages, skip`
      );
      continue;
    }

    // Suspicious data check: price per portion < 5000 suggests a sheet entry error
    if (lastPurchase.price > 0 && lastPurchase.price < 5000) {
      skipped.push(`${sheetName}: suspicious price ${lastPurchase.price}/p — skip`);
      continue;
    }
    // Also check any older purchase
    const suspiciousOlder = olderPurchases.find(p => p.price > 0 && p.price < 5000);
    if (suspiciousOlder) {
      skipped.push(`${sheetName}: suspicious price ${suspiciousOlder.price}/p in ${suspiciousOlder.date} purchase — skip`);
      continue;
    }

    console.log(`\n─── ${sheetName} ───`);
    console.log(`  Import order: ${existingOrder.id} (${existingOrder.start_date}, ${existingOrder.package_size}p @ ${existingOrder.price_per_portion}/p, remaining=${existingOrder.portions_remaining})`);

    // 1. Delete junk orders (verify no deliveries)
    for (const junk of junkOrders) {
      const { count } = await db.from('daily_deliveries').select('id', { count: 'exact', head: true }).eq('order_id', junk.id);
      if ((count ?? 0) > 0) {
        console.log(`  ⚠ Junk order ${junk.id} has ${count} deliveries — not deleting`);
        continue;
      }
      console.log(`  🗑 Delete junk order ${junk.id} (${junk.start_date}, ${junk.package_size}p)`);
      if (!dryRun) {
        const { error } = await db.from('orders').delete().eq('id', junk.id);
        if (error) console.error(`    ERROR: ${error.message}`);
        else totalDeleted++;
      } else {
        totalDeleted++;
      }
    }

    // 2. Create completed orders for older purchases
    for (const p of olderPurchases) {
      console.log(`  + Create completed order: ${p.date}, ${p.porsi}p @ ${p.price}/p = Rp${p.total.toLocaleString('id-ID')}`);
      if (!dryRun) {
        const { error } = await db.from('orders').insert({
          customer_id: existingOrder.customer_id,
          subcontractor_id: existingOrder.subcontractor_id,
          status: 'completed',
          package_size: p.porsi,
          portions_remaining: 0,
          price_per_portion: p.price,
          total_price: p.total,
          meal_time_preference: existingOrder.meal_time_preference || 'per_day_decision',
          portions_per_delivery: existingOrder.portions_per_delivery || 1,
          start_date: p.date,
        });
        if (error) console.error(`    ERROR: ${error.message}`);
        else totalCreated++;
      } else {
        totalCreated++;
      }
    }

    // 3. Update existing import order to most recent purchase
    console.log(`  ✎ Update import order → ${lastPurchase.date}, ${lastPurchase.porsi}p @ ${lastPurchase.price}/p = Rp${lastPurchase.total.toLocaleString('id-ID')} (keeping portions_remaining=${existingOrder.portions_remaining})`);
    if (!dryRun) {
      const { error } = await db.from('orders').update({
        start_date: lastPurchase.date,
        package_size: lastPurchase.porsi,
        price_per_portion: lastPurchase.price,
        total_price: lastPurchase.total,
      }).eq('id', existingOrder.id);
      if (error) console.error(`    ERROR: ${error.message}`);
      else totalUpdated++;
    } else {
      totalUpdated++;
    }
  }

  console.log(`\n=== Summary (${dryRun ? 'DRY RUN' : 'APPLIED'}) ===`);
  console.log(`  Junk orders deleted: ${totalDeleted}`);
  console.log(`  Historical orders created: ${totalCreated}`);
  console.log(`  Import orders updated: ${totalUpdated}`);

  if (skipped.length > 0) {
    console.log(`\nSkipped (${skipped.length}):`);
    for (const s of skipped) console.log(`  · ${s}`);
  }
}

function isJunk(o: DbOrder): boolean {
  // Zero-portion orders from second import run (Jun 24 artifacts)
  return (o.package_size ?? 0) === 0 && (o.portions_remaining ?? 0) === 0;
}

main().catch(console.error);
