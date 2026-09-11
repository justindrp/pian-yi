import type { SupabaseClient } from "@supabase/supabase-js";
import { getSetting } from "@/lib/cache/settings";
import type { Database } from "@/types/database";

/**
 * How many tasks may sit in `in_progress` at once.
 *
 * The cap is the point of the status. /tasks carries 232 live rows, which is
 * well past what anyone tracks unaided, so `in_progress` is the page's answer
 * to "what am I on right now" — and an answer listing nine things is the same
 * as no answer. Justin holds three.
 *
 * Falls back to 3 when the setting is missing or unparseable rather than to
 * unlimited: a typo in the settings row should not quietly remove the cap.
 */
export const DEFAULT_WIP_LIMIT = 3;

export async function wipLimit(): Promise<number> {
  const raw = Number.parseInt(await getSetting("task_wip_limit"), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_WIP_LIMIT;
}

/**
 * Returns the sentence to refuse a start with, or null if there is room. The
 * count is read at the moment of the write rather than trusted from the client,
 * which is looking at a list that may be a minute old.
 */
export async function wipRefusal(
  db: SupabaseClient<Database>,
): Promise<string | null> {
  const limit = await wipLimit();
  const { count, error } = await db
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "in_progress");
  // A failed count must not become an accidental "no limit". Nothing is lost by
  // refusing: the caller can retry, and the alternative is a silent fourth.
  if (error) return "Could not check how many tasks are in progress";
  if ((count ?? 0) < limit) return null;
  return `${count} tasks are already in progress and the limit is ${limit}. Stop one first.`;
}
