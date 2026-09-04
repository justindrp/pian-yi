import type { SupabaseClient } from "@supabase/supabase-js";
import { jakartaMinuteOfDay } from "@/lib/time/jakarta";
import type { Database } from "@/types/database";

/**
 * When the food actually arrives, per meal and per kitchen.
 *
 * Quoted to customers, so it lives in one place: the schedule block in the
 * system prompt and the "belum sampai" answer from `send_delivery_proof` have
 * to agree, or the bot names one window and contradicts it a message later.
 *
 * Not the order deadline. `settings.order_deadline_hour` is when we stop taking
 * changes for tomorrow; this is when the courier is at the door.
 *
 * These two are the fallback for a kitchen nobody has measured. The real
 * numbers live on `subcontractors` (migration 093), because they are a fact
 * about a kitchen's courier and not about the meal: Thenie arrives 11.30-12.30
 * and was being quoted 10.00-12.00, which is how Naya came to be told at 11.09
 * on 2026-09-02 that her food was late when by her kitchen's own window it had
 * not been due yet.
 *
 * Minutes from midnight, not hours — 12.30 has no hour-resolution spelling.
 */
export const DELIVERY_WINDOWS = {
  lunch: { startMin: 10 * 60, endMin: 12 * 60 },
  dinner: { startMin: 16 * 60, endMin: 18 * 60 },
} as const;

export type MealWindowKey = keyof typeof DELIVERY_WINDOWS;

export type DeliveryWindow = {
  /** As the customer reads it: "11.30-12.30". */
  label: string;
  startMin: number;
  endMin: number;
};

/** The four nullable columns migration 093 put on `subcontractors`. */
export type KitchenWindows = {
  lunch_window_start_min: number | null;
  lunch_window_end_min: number | null;
  dinner_window_start_min: number | null;
  dinner_window_end_min: number | null;
};

/** "11.30", the way a window is written to a customer. */
function clock(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}.${String(min % 60).padStart(2, "0")}`;
}

export function windowLabel(startMin: number, endMin: number): string {
  return `${clock(startMin)}-${clock(endMin)}`;
}

/**
 * The window for a `daily_deliveries.meal_type`, defaulting to lunch.
 *
 * `kitchen` is the subcontractor row that cooks it. A kitchen with nothing
 * recorded — every one of them until it is measured — falls back to the
 * constants above, so a missing row can only ever cost accuracy, never an
 * answer. Both columns of a pair have to be set: half a window is not one.
 */
export function deliveryWindow(
  mealType: string,
  kitchen?: KitchenWindows | null,
): DeliveryWindow {
  const dinner = mealType === "dinner";
  const start = dinner
    ? kitchen?.dinner_window_start_min
    : kitchen?.lunch_window_start_min;
  const end = dinner
    ? kitchen?.dinner_window_end_min
    : kitchen?.lunch_window_end_min;
  const fallback = dinner ? DELIVERY_WINDOWS.dinner : DELIVERY_WINDOWS.lunch;
  const startMin = start != null && end != null ? start : fallback.startMin;
  const endMin = start != null && end != null ? end : fallback.endMin;
  return { label: windowLabel(startMin, endMin), startMin, endMin };
}

/**
 * Which of a customer's delivery rows a photo taken at `at` documents.
 *
 * One row that day is not a question. Two — a customer eating both meals — has
 * no answer in the photo itself, so the window is the tiebreak: nothing shot
 * before the dinner window opens can be dinner. It is a guess, and it is only
 * ever made for the both-meals customers; everyone else is exact.
 */
export function pickDeliveryForPhoto<T extends { meal_type: string }>(
  rows: T[],
  at: Date,
  kitchen?: KitchenWindows | null,
): T | null {
  if (rows.length <= 1) return rows[0] ?? null;
  const wantDinner =
    jakartaMinuteOfDay(at) >= deliveryWindow("dinner", kitchen).startMin;
  return rows.find((r) => (r.meal_type === "dinner") === wantDinner) ?? rows[0];
}

const KITCHEN_WINDOW_COLUMNS =
  "id, lunch_window_start_min, lunch_window_end_min, dinner_window_start_min, dinner_window_end_min";

/**
 * The windows of the kitchens that cook a set of delivery rows, by
 * `subcontractor_id`.
 *
 * A row whose kitchen is null — the June import left plenty — simply misses the
 * map and takes the defaults.
 */
export async function loadKitchenWindows(
  db: SupabaseClient<Database>,
  subcontractorIds: (string | null)[],
): Promise<Map<string, KitchenWindows>> {
  const ids = [...new Set(subcontractorIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const { data } = await db
    .from("subcontractors")
    .select(KITCHEN_WINDOW_COLUMNS)
    .in("id", ids);
  return new Map(
    ((data ?? []) as unknown as (KitchenWindows & { id: string })[]).map((k) => [
      k.id,
      k,
    ]),
  );
}
