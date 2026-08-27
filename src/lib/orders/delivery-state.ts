import type { SupabaseClient } from "@supabase/supabase-js";
import { logEdit } from "@/lib/audit/log-edit";
import { getSetting } from "@/lib/cache/settings";
import { jakartaDateString } from "@/lib/menu/week";
import { addDays, jakartaHour } from "@/lib/time/jakarta";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/** The cutoff when `settings.order_deadline_hour` is unreadable. 16:00 WIB. */
export const DEFAULT_DEADLINE_HOUR = 16;

/**
 * `settings.order_deadline_hour`, falling back to 16:00 WIB.
 *
 * Same reader and same fallback as `cron/cancel-unpaid`. Anything that asks
 * "is it too late" must agree with it — a second copy with a different default
 * lets the sweep and the skip button disagree about the same afternoon.
 */
export async function loadDeadlineHour(): Promise<number> {
  const raw = await getSetting("order_deadline_hour");
  return Number.parseInt(raw, 10) || DEFAULT_DEADLINE_HOUR;
}

/**
 * Whether a delivery's booking is locked with the kitchen.
 *
 * True from the H-1 deadline onwards — 16:00 WIB the day before the delivery
 * date. Past that the sheet has gone out, we owe the kitchen for the portion
 * whether or not the customer eats it, and there is nothing left to skip.
 *
 * This replaced `daily_deliveries.status`. The status column claimed to record
 * the same thing and never did: every row it ever held said 'scheduled',
 * including rows for meals eaten months earlier. The date and the clock always
 * knew the answer, so nothing needed to remember it.
 */
export function isLocked(
  deliveryDate: string,
  opts: { deadlineHour?: number; now?: Date } = {},
): boolean {
  const now = opts.now ?? new Date();
  const deadlineHour = opts.deadlineHour ?? DEFAULT_DEADLINE_HOUR;
  const today = jakartaDateString(now);
  const date = deliveryDate.slice(0, 10);

  if (date <= today) return true;
  // Tomorrow locks at the deadline; anything later is still open.
  return date === addDays(today, 1) && jakartaHour(now) >= deadlineHour;
}

/**
 * What a delivery row would have called itself, for display only.
 *
 * Never persist this and never branch quota on it. "Has this food been eaten"
 * is a different question from "is this booking locked" — a meal locked at
 * 16:00 today for tomorrow is drawn against the kitchen but still owed to the
 * customer — and the ledgers answer that one with `date <= today`.
 */
export function deliveryStatus(
  deliveryDate: string,
  opts: { deadlineHour?: number; now?: Date } = {},
): "delivered" | "scheduled" {
  return isLocked(deliveryDate, opts) ? "delivered" : "scheduled";
}

type DeletedDelivery = {
  id: string;
  delivery_date: string;
  customer_id: string | null;
  order_id: string | null;
  meal_type: string | null;
  portions: number | null;
};

/**
 * Removes a delivery row, keeping a copy of it in `edit_log` first.
 *
 * The snapshot is the point. A skip is a DELETE now, and the fields that make
 * a row rebuildable — order_id, subcontractor_id, address_slot, portions,
 * meal_type — cannot be recovered from the conversation that asked for it. An
 * admin who deletes the wrong row, or a bot that reads "besok saya ga di rumah"
 * as a skip when the customer meant something else, leaves the only copy here.
 *
 * `delivery_proofs` has an FK to this row with no cascade, so proofs are
 * detached before the delete or Postgres refuses it.
 *
 * Returns the deleted row, or null when the id matched nothing.
 */
export async function deleteDelivery(params: {
  db: Db;
  id: string;
  actor: string;
  reason: string;
}): Promise<DeletedDelivery | null> {
  const { db, id, actor, reason } = params;

  const { data: row } = await db
    .from("daily_deliveries")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!row) return null;

  const detach = await db
    .from("delivery_proofs")
    .update({ matched_delivery_id: null })
    .eq("matched_delivery_id", id);
  if (detach.error) throw new Error(detach.error.message);

  const { error } = await db.from("daily_deliveries").delete().eq("id", id);
  if (error) throw new Error(error.message);

  await logEdit({
    db,
    actor,
    entityType: "daily_deliveries",
    entityId: id,
    action: "delete_delivery",
    changes: { reason, row },
  });

  return row as DeletedDelivery;
}
