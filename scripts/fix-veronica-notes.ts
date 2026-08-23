import { createClient } from '@supabase/supabase-js';
import { requiredEnv } from '../src/lib/env';
import { logEdit } from '../src/lib/audit/log-edit';

const ID = '3c7383cb-7c12-440e-9637-f1cf844a6479';
const APPLY = process.argv.includes('--apply');

const NOTES = `[AI learned context]
- Paket terakhir: 6 porsi (Rp 174.000), sudah ditransfer 23 Agustus 2026. Sebelum itu masih ada sisa 4 porsi dari paket lama, jadi total kuota 10 porsi. Tidak ada kekurangan pembayaran.
- Jadwal 24-29 Agustus 2026: Senin, Selasa, Rabu, Kamis dinner; Jumat dan Sabtu lunch + dinner. Terpakai 8 porsi, sisa 2 porsi untuk minggu berikutnya.
- Alamat pengiriman: Perumahan Sutera Palmyra Blok 1A No. 33, Alam Sutera.
- Sistem kuota: bisa skip hari, sisa porsi tidak hangus dan dibawa ke minggu depan. Perubahan sebelum jam 16.00 WIB H-1.
[/AI learned context]`;

async function main() {
  const db = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
  const { data: before } = await db.from('customers').select('notes').eq('id', ID).single();
  console.log(`--- BEFORE ---\n${before?.notes}\n--- AFTER ---\n${NOTES}`);
  if (!APPLY) { console.log('\nDRY RUN — rerun with --apply'); return; }
  const { error } = await db.from('customers').update({ notes: NOTES }).eq('id', ID);
  if (error) throw error;
  await logEdit({
    db, actor: 'justindrp2@gmail.com', entityType: 'customers', entityId: ID,
    action: 'rewrite_ai_context',
    changes: { reason: 'learned context captured the bot\'s wrong figures (Rp 174.000 as the full package, start Rabu 26, sisa 4)', before: before?.notes, after: NOTES },
  });
  console.log('updated + edit_log written.');
}
main().catch(e => { console.error(e); process.exit(1); });
