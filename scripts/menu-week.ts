/**
 * Promotes one stored week out of `subcontractor_menu_weeks` into the kitchen's
 * live `subcontractors.menu_text`, which is the column everything downstream
 * reads: the bot's answers, scripts/menu-photos.ts and scripts/menu-card.ts.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/menu-week.ts --kitchen <nickname|name|id>
 *                                                       [--week YYYY-MM-DD] [--apply]
 *
 * Without `--week` it takes the week `defaultMenuWeekStart` names — this week
 * Senin–Rabu, next week from Kamis on, the same guess the card makes. Without
 * `--apply` it prints the stored weeks and the text it would write, and touches
 * nothing.
 *
 * It does NOT touch `menu_week_start`. That column says which week the *image*
 * on file covers, and the image is still last week's until menu-card.ts has run
 * with `--upload`; moving it here would have the bot introduce an old card as
 * next week's menu. The week goes: promote the text, draw the card, upload —
 * and the upload is what moves `menu_week_start`.
 */

import { logEdit } from "@/lib/audit/log-edit";
import { defaultMenuWeekStart, jakartaDateString } from "@/lib/menu/week";
import { createAdminClient } from "@/lib/supabase/admin";

async function main() {
  const argv = process.argv.slice(2);
  const asked = argv.includes("--kitchen")
    ? (argv[argv.indexOf("--kitchen") + 1] ?? "").trim()
    : "";
  if (!asked) throw new Error("--kitchen needs a nickname, a name or an id");

  const statedWeek = argv.includes("--week")
    ? (argv[argv.indexOf("--week") + 1] ?? "").trim()
    : "";
  if (statedWeek && !/^\d{4}-\d{2}-\d{2}$/.test(statedWeek))
    throw new Error("--week needs a Monday as YYYY-MM-DD");
  const weekStart = statedWeek || defaultMenuWeekStart(jakartaDateString());
  const apply = argv.includes("--apply");

  const db = createAdminClient();
  const { data: kitchens, error } = await db
    .from("subcontractors")
    .select("id, name, customer_nickname, menu_text, menu_week_start");
  if (error) throw new Error(error.message);

  const needle = asked.toLowerCase();
  const kitchen = (kitchens ?? []).find(
    (k) =>
      k.id === asked ||
      (k.customer_nickname ?? "").toLowerCase().includes(needle) ||
      k.name.toLowerCase().includes(needle),
  );
  if (!kitchen) throw new Error(`no kitchen matches "${asked}"`);

  const { data: weeks, error: weekErr } = await db
    .from("subcontractor_menu_weeks")
    .select("week_start, menu_text")
    .eq("subcontractor_id", kitchen.id)
    .order("week_start");
  if (weekErr) throw new Error(weekErr.message);

  const label = kitchen.customer_nickname ?? kitchen.name;
  console.log(`${label} — card on file covers ${kitchen.menu_week_start}`);
  if (!weeks?.length)
    throw new Error(
      `${label} has no stored weeks — transcribe the kitchen's poster into subcontractor_menu_weeks first`,
    );
  for (const w of weeks)
    console.log(
      `  ${w.week_start}${w.menu_text === kitchen.menu_text ? "  ← live in menu_text" : ""}`,
    );

  const week = weeks.find((w) => w.week_start === weekStart);
  if (!week)
    throw new Error(
      `${label} has no stored week starting ${weekStart} — the poster it came from stops earlier`,
    );

  console.log(`\nwould write ${weekStart} into menu_text:\n${week.menu_text}`);
  if (!apply) return console.log("\ndry run — pass --apply");
  if (week.menu_text === kitchen.menu_text)
    return console.log("\nalready live — nothing to write");

  const { error: updErr } = await db
    .from("subcontractors")
    .update({ menu_text: week.menu_text, updated_at: new Date().toISOString() })
    .eq("id", kitchen.id);
  if (updErr) throw new Error(updErr.message);

  await logEdit({
    db,
    actor: "script:menu-week",
    entityType: "subcontractors",
    entityId: kitchen.id,
    action: "update",
    changes: { menu_text: week.menu_text },
  });
  console.log(
    `\n→ ${label} menu_text = week of ${weekStart}. Draw the card next: scripts/menu-card.ts --kitchen "${label}" --week ${weekStart} --upload`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
