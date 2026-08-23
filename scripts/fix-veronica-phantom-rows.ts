import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { requiredEnv } from '../src/lib/env';
import { logEdit } from '../src/lib/audit/log-edit';

const ID = '3c7383cb-7c12-440e-9637-f1cf844a6479';
const APPLY = process.argv.includes('--apply');

// The two rows the generator laid down on 2026-06-08 for a both_fixed week that
// the customer did not take: the Google Sheet (the operational record of what
// the kitchen actually cooked) has 6/12 dinner only and 6/13 lunch only.
const PHANTOMS = [
  { date: '2026-06-12', meal: 'lunch' },
  { date: '2026-06-13', meal: 'dinner' },
];

async function main() {
  const db = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY)
  );

  const { data: rows, error } = await db.from('daily_deliveries')
    .select('*').eq('customer_id', ID)
    .in('delivery_date', PHANTOMS.map(p => p.date));
  if (error) throw error;

  const targets = (rows ?? []).filter(r =>
    PHANTOMS.some(p => p.date === r.delivery_date && p.meal === r.meal_type));

  console.log(`matched ${targets.length} row(s) to delete (expect 2):`);
  for (const t of targets) console.log(`  ${t.delivery_date} ${t.meal_type} p=${t.portions} order=${t.order_id?.slice(0,8)} id=${t.id}`);
  if (targets.length !== 2) throw new Error(`expected exactly 2 rows, got ${targets.length} — aborting`);

  const backup = `scripts/rollback/veronica-phantom-rows-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
  writeFileSync(backup, JSON.stringify(targets, null, 2));
  console.log(`rollback written: ${backup}`);

  if (!APPLY) { console.log('\nDRY RUN — rerun with --apply'); return; }

  const { error: delErr } = await db.from('daily_deliveries').delete().in('id', targets.map(t => t.id));
  if (delErr) throw delErr;
  console.log('deleted.');

  await logEdit({
    db, actor: 'justindrp2@gmail.com',
    entityType: 'daily_deliveries', entityId: ID,
    action: 'delete_phantom_draws',
    changes: {
      reason: 'generator wrote a full both_fixed week on 2026-06-08; the Google Sheet order_harian shows only 6/12 dinner and 6/13 lunch were delivered. DB draws 30 vs sheet 28.',
      deleted: targets.map(t => ({ id: t.id, delivery_date: t.delivery_date, meal_type: t.meal_type, portions: t.portions, order_id: t.order_id })),
      rollback_file: backup,
    },
  });
  console.log('edit_log written.');
}
main().catch(e => { console.error(e); process.exit(1); });
