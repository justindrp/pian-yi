/**
 * Repairs the `Preferensi:` bullets that the summarizer invented.
 *
 * Until 2026-08-30 the prompt in `src/lib/claude/learn-context.ts` named
 * "tanpa nasi, tidak pedas, tanpa seafood, alergi" as its example of a dietary
 * restriction, and the model copied that example into the bullet as fact. Five
 * customers carried the list; only Lidya had ever asked for any of it. The
 * bullet is the one part of the AI block that `/dapur/[id]` re-admits, so an
 * invented restriction is cooked: Kurniadi Tan had 16 deliveries starting the
 * next morning and 48 messages that never mention food.
 *
 * The prompt is fixed, but a regenerated summary overwrites these notes on the
 * customer's next message — that is how Carolin's bullet came back an hour
 * after it was corrected by hand. Run this after the prompt fix is deployed,
 * not before.
 *
 *   tsx --env-file=.env.local scripts/fix-invented-preferences.ts [--apply]
 */
import { createClient } from "@supabase/supabase-js";
import { logEdit } from "../src/lib/audit/log-edit";
import { requiredEnv } from "../src/lib/env";

const APPLY = process.argv.includes("--apply");

/**
 * The replacement bullet for each customer, and why it reads that way. Every
 * non-dietary fact already in the bullet (drop-off point, schedule rule) is
 * kept — the kitchen acts on those and they were never in doubt.
 */
const FIXES: {
  phone: string;
  name: string;
  bullet: string;
  reason: string;
}[] = [
  {
    phone: "+628119303475",
    name: "Kurniadi Tan",
    bullet:
      "Preferensi: tidak ada permintaan khusus; jadwal pengiriman harus sesuai daftar spesifik pelanggan, bukan rata siang+malam setiap hari; alamat drop-off SAUMATA Apartment Tower 1 Lt.2, Alam Sutera; perubahan/skip wajib H-1 sebelum jam 16.00.",
    reason:
      "48 customer messages, none mentioning food; the bullet itself said the restrictions were 'tidak disebutkan eksplisit di transkrip' while asserting three of them. 16 deliveries from 2026-08-31.",
  },
  {
    phone: "+6281232798189",
    name: "Carolin",
    bullet: "Preferensi: tidak ada permintaan khusus.",
    reason:
      "29 customer messages, none stating a restriction; the only food word she typed was 'nasi box'. One delivery on 2026-09-01.",
  },
  {
    phone: "+6285800472147",
    name: "Julian S",
    bullet:
      "Preferensi: makanan tanpa kacang dan tanpa bawang goreng; titip di bagian drop off, info ke petugas kalau makanan diantar ke atas.",
    reason:
      "the invented list replaced his real request — 'Makanan tidak ada kacang dan Bawang goreng', typed into the order form he filled and sent back — which never reached the bullet at all.",
  },
  {
    phone: "+62817176329",
    name: "(no name)",
    bullet: "Preferensi: tidak ada permintaan khusus.",
    reason:
      "3 messages, still browsing, no order; the bullet listed all four example terms and then said 'belum ada permintaan spesifik dari pelanggan'.",
  },
];

const PREF_LINE = /^-?\s*Preferensi:.*$/m;

async function main() {
  const db = createClient(
    requiredEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    ),
    requiredEnv(
      "SUPABASE_SERVICE_ROLE_KEY",
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    ),
  );

  for (const fix of FIXES) {
    const { data: customer } = await db
      .from("customers")
      .select("id, name, notes")
      .eq("phone_number", fix.phone)
      .single();
    if (!customer?.notes) {
      console.log(`SKIP ${fix.name} ${fix.phone} — no customer or no notes`);
      continue;
    }

    const before = customer.notes;
    const existing = PREF_LINE.exec(before);
    if (!existing) {
      console.log(`SKIP ${fix.name} — no Preferensi bullet to replace`);
      continue;
    }
    // The bullets are written with a leading "- " everywhere except Kurniadi's,
    // where the summarizer emitted it as a bare paragraph. Reuse whatever
    // prefix is already there so the block's shape is untouched.
    const prefix = existing[0].startsWith("-") ? "- " : "";
    const after = before.replace(PREF_LINE, `${prefix}${fix.bullet}`);

    console.log(`\n=== ${fix.name} ${fix.phone}`);
    console.log(`  reason : ${fix.reason}`);
    console.log(`  before : ${existing[0].trim()}`);
    console.log(`  after  : ${prefix}${fix.bullet}`);

    if (!APPLY) continue;

    const { error } = await db
      .from("customers")
      .update({ notes: after })
      .eq("id", customer.id);
    if (error) throw error;

    await logEdit({
      db,
      actor: "justindrp2@gmail.com",
      entityType: "customers",
      entityId: customer.id,
      action: "fix_invented_preference",
      changes: {
        reason: `summarizer copied its own prompt example into the Preferensi bullet — ${fix.reason}`,
        before,
        after,
      },
    });
    console.log("  updated + edit_log written.");
  }

  if (!APPLY) console.log("\nDRY RUN — rerun with --apply");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
