/**
 * Audit repair of customers.kitchen_notes, 2026-09-01.
 *
 * kitchen_notes is the only thing /dapur/[id] prints (migration 089), so a
 * preference that never lands here never reaches the food. Sweeping all 416
 * customers against their own chat history found four kinds of rot:
 *
 *   1. Preferences the customer stated after their order existed. Nothing
 *      carries those into kitchen_notes — the summarizer writes them into the
 *      [AI learned context] block in customers.notes, which the kitchen sheet
 *      is forbidden to read. Naya was told twice her request was "dicatat" and
 *      was served twice without it.
 *   2. Notes that were true on the day they were written and expire. Julian's
 *      "titip di drop off" was for 1 September only; he said in the same
 *      breath "besok dan seterusnya tetap diantar keatas". Left alone it
 *      reverses his standing instruction from 2 September onward.
 *   3. A duplicated, half-expired block on Sharleen carrying both a live rule
 *      and a dead one.
 *   4. Trailing "\n\n" on thirteen notes from the migration 089 seed.
 *
 * Every value below is the customer's own words from their thread, never the
 * AI summary. That distinction is the whole point: Carolin's notes block still
 * claims "tidak pedas, tanpa seafood" and her chat contains no such request,
 * so she is deliberately left null rather than seeded from it. Copying that
 * block into the kitchen is the bug migration 089 exists to prevent.
 *
 *   tsx scripts/fix-kitchen-notes-audit.ts [--apply]
 */
import { logEdit } from "../src/lib/audit/log-edit";
import { createAdminClient } from "../src/lib/supabase/admin";

const ACTOR = "system:kitchen-notes-audit-2026-09-01";

/** name -> the note it should hold. null stays null; "" is never written. */
const FIXES: { name: string; to: string; why: string }[] = [
  {
    name: "Naya",
    to: "Sambal dipisah, tanpa tempe",
    why: 'her own words 31/08 — bot confirmed "dicatat" twice, kitchen never saw it',
  },
  {
    name: "Vania",
    to: "Rabu 2 September: minta menu ayam (ayam tumis). Dinner only.",
    why: "her own words 30/08 13:28 and 31/08 10:14; she picks her menu weekly",
  },
  {
    name: "Winy",
    to: "Senin-Jumat: antar ke Synergy Building, tidak bisa dititip di lobby. Sabtu: Brooklyn Apartment unit B19G, titip satpam.",
    why: "her own words 30/08 07:04 and 01/09 12:20; address_2 already holds the Sabtu address",
  },
  {
    name: "Julian S",
    to: "Makanan diantar ke atas (lantai atas)\ntidak ada kacang dan bawang goreng",
    why: 'drops the 1 September drop-off line — he said "besok dan seterusnya tetap diantar keatas"',
  },
  {
    name: "Sharleen",
    to: "Senin-Jumat: 3 porsi — 2 pedas, 1 tidak pedas. 30 Sep: 2 pedas, 2 tidak pedas.\nTaruh di meja makan samping lobi, maksimal jam 18.00, kurir tidak menunggu.\nFoto makanan setelah ditaruh (bukti pengantaran).",
    why: 'drops the expired "1-2 Sep" line and the duplicated second line; adds the photo she asked for twice on 31/08',
  },
  {
    name: "Rachel",
    to: "Titip di security belakang, tulis nama Rachel Lt 11.",
    why: "drops the standing Rabu-cumi line — she was told 01/09 it only runs when she confirms by Sabtu, so the sheet must not imply it is automatic",
  },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createAdminClient();

  const { data: cust, error } = await db
    .from("customers")
    .select("id, name, kitchen_notes")
    .not("kitchen_notes", "is", null);
  if (error) throw new Error(error.message);

  // Trailing whitespace from the migration 089 seed. Cosmetic on the page, but
  // it makes every diff of this column unreadable.
  const trims = (cust ?? []).filter(
    (c) =>
      c.kitchen_notes !== c.kitchen_notes.trim() &&
      !FIXES.some((f) => f.name === c.name),
  );

  console.log(`--- ${FIXES.length} rewrites ---`);
  for (const f of FIXES) {
    const { data: c } = await db
      .from("customers")
      .select("id, kitchen_notes")
      .eq("name", f.name)
      .single();
    if (!c) throw new Error(`no customer ${f.name}`);
    console.log(`\n${f.name}\n  from: ${JSON.stringify(c.kitchen_notes)}\n  to:   ${JSON.stringify(f.to)}\n  why:  ${f.why}`);
    if (!apply) continue;
    const { error: upErr } = await db
      .from("customers")
      .update({ kitchen_notes: f.to })
      .eq("id", c.id);
    if (upErr) throw new Error(`${f.name}: ${upErr.message}`);
    await logEdit({
      db,
      actor: ACTOR,
      entityType: "customer",
      entityId: c.id,
      action: "update_kitchen_notes",
      changes: { kitchen_notes: { from: c.kitchen_notes, to: f.to }, reason: f.why },
    });
  }

  console.log(`\n--- ${trims.length} whitespace trims ---`);
  for (const c of trims) {
    const to = c.kitchen_notes.trim();
    console.log(`  ${c.name}: ${JSON.stringify(c.kitchen_notes)} -> ${JSON.stringify(to)}`);
    if (!apply) continue;
    const { error: upErr } = await db
      .from("customers")
      .update({ kitchen_notes: to })
      .eq("id", c.id);
    if (upErr) throw new Error(`${c.name}: ${upErr.message}`);
    await logEdit({
      db,
      actor: ACTOR,
      entityType: "customer",
      entityId: c.id,
      action: "update_kitchen_notes",
      changes: { kitchen_notes: { from: c.kitchen_notes, to }, reason: "trim seed whitespace" },
    });
  }

  console.log(apply ? "\napplied" : "\ndry run — pass --apply");
}

main();
