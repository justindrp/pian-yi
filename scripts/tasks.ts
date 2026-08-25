/**
 * Prints the open task queue. Replaces the old TASKS.md — the queue lives in
 * the `tasks` table now, edited at /tasks in the dashboard.
 *
 *   pnpm tasks           open + in_progress + blocked
 *   pnpm tasks all       everything, done included
 *   pnpm tasks <area>    one area
 */
import { createAdminClient } from "../src/lib/supabase/admin";

const STATUS_MARK: Record<string, string> = {
  open: " ",
  in_progress: "~",
  blocked: "!",
  done: "x",
};

async function main() {
  const arg = process.argv[2] ?? "";
  const db = createAdminClient();

  let q = db
    .from("tasks")
    .select("title, body, status, priority, area, assignee, blocked_on, due_date")
    .order("priority")
    .order("created_at");

  if (arg !== "all") q = q.neq("status", "done");
  if (arg && arg !== "all") q = q.eq("area", arg);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const tasks = data ?? [];

  const byArea = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const key = t.area ?? "(no area)";
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key)?.push(t);
  }

  for (const [area, rows] of byArea) {
    console.log(`\n## ${area}`);
    for (const t of rows) {
      const bits = [
        t.priority === 1 ? "HIGH" : null,
        t.assignee,
        t.due_date ? `due ${t.due_date}` : null,
        t.blocked_on ? `waiting on ${t.blocked_on}` : null,
      ].filter(Boolean);
      console.log(
        `[${STATUS_MARK[t.status] ?? "?"}] ${t.title}${bits.length ? `  (${bits.join(", ")})` : ""}`,
      );
      if (t.body) {
        for (const line of t.body.split("\n")) console.log(`      ${line}`);
      }
    }
  }
  console.log(`\n${tasks.length} task(s).`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  },
);
