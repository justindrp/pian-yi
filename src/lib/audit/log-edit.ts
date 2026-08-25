import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/**
 * Records who did something, in `edit_log`.
 *
 * The table already existed and fourteen routes wrote to it by hand; the
 * problem was the routes that did not. On 2026-08-21 `edit_log` held 313 rows
 * covering daily-sheet saves, settings, admin changes and free-quota grants —
 * and nothing at all for orders (mark paid, cancel, edit), customers (address,
 * area, notes, kitchen assignment), the Assistant's confirmed write tools, the
 * accounting journal, or the subcontractor roster. A delivery photo could be
 * traced to the admin who sent it; an order could not be traced to the admin
 * who cancelled it.
 *
 * Call this after the write lands, never before: it deliberately does not throw.
 * The business write has already succeeded by then, and failing the request over
 * a missing audit row would turn a bookkeeping problem into a user-visible 500
 * for an action that actually happened. A failure is loud in the logs instead.
 *
 * `actor` is the admin's email from `getSessionWithRole()`. For a cron or the
 * webhook, use the `SYSTEM_ACTOR` prefix so a machine write is never mistaken
 * for a person's.
 */
export async function logEdit(params: {
  db: Db;
  actor: string;
  entityType: string;
  entityId: string;
  action: string;
  changes: Record<string, unknown>;
}): Promise<void> {
  const { error } = await params.db.from("edit_log").insert({
    entity_type: params.entityType,
    entity_id: params.entityId,
    action: params.action,
    changed_by: params.actor,
    changes: params.changes as never,
  });

  if (error) {
    console.error(
      `logEdit failed — ${params.entityType}/${params.action} ${params.entityId} by ${params.actor}: ${error.message}`,
    );
  }
}

/** Prefix for a write nobody pressed a button for. `system:deduct-daily-quota`. */
export function systemActor(job: string): string {
  return `system:${job}`;
}
