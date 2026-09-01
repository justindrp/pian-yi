import { jakartaHour } from "@/lib/time/jakarta";

/**
 * When the food actually arrives, per meal.
 *
 * Quoted to customers, so it lives in one place: the schedule block in the
 * system prompt and the "belum sampai" answer from `send_delivery_proof` have
 * to agree, or the bot names one window and contradicts it a message later.
 *
 * Not the order deadline. `settings.order_deadline_hour` is when we stop taking
 * changes for tomorrow; this is when the courier is at the door.
 */
export const DELIVERY_WINDOWS = {
  lunch: { label: "10.00-12.00", startHour: 10, endHour: 12 },
  dinner: { label: "16.00-18.00", startHour: 16, endHour: 18 },
} as const;

export type MealWindowKey = keyof typeof DELIVERY_WINDOWS;

/** The window for a `daily_deliveries.meal_type`, defaulting to lunch. */
export function deliveryWindow(mealType: string) {
  return mealType === "dinner"
    ? DELIVERY_WINDOWS.dinner
    : DELIVERY_WINDOWS.lunch;
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
): T | null {
  if (rows.length <= 1) return rows[0] ?? null;
  const wantDinner = jakartaHour(at) >= DELIVERY_WINDOWS.dinner.startHour;
  return (
    rows.find((r) => (r.meal_type === "dinner") === wantDinner) ?? rows[0]
  );
}
