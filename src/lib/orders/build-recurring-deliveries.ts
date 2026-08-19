import { isClosedHoliday } from "@/lib/holidays/id";

type MealType = "lunch" | "dinner";

type RecurringDeliveryOrder = {
  customer_id: string | null;
  end_date: string | null;
  lunch_address_slot: number | null;
  dinner_address_slot: number | null;
  meal_time_preference: string | null;
  order_id: string;
  package_size: number | null;
  portions_dinner: number | null;
  portions_lunch: number | null;
  portions_per_delivery: number | null;
  start_date: string | null;
  subcontractor_id: string | null;
};

type DeliveryRow = {
  address_slot: number;
  customer_id: string;
  delivery_date: string;
  meal_type: MealType;
  order_id: string;
  portions: number;
  status: "delivered" | "scheduled";
  subcontractor_id: string | null;
};

// An order has a fixed schedule when its meal_time_preference names a standing
// pattern, so its delivery days can be worked out without asking the customer.
// Everything else — per_day_decision, custom_schedule, null — is a plain quota
// package whose delivery rows only exist once the customer asks for them.
//
// This replaced the order_type column. order_type claimed to draw the same line
// but defaulted to 'recurring' on every insert, so 252 of 301 active orders
// carried 'recurring' while their preference said per_day_decision. Generating
// from the flag meant generating lunch AND dinner for every one of them.
export const FIXED_SCHEDULE_PREFS = [
  "lunch_only",
  "dinner_only",
  "both_fixed",
  "keduanya",
  "default_lunch",
  "default_dinner",
];

function parseIsoDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Senin–Sabtu. The only active kitchen delivers on Saturday, so a weekly
// schedule is 5 or 6 days and the 6-day package sizes are sellable — but this
// function excluded Saturday, so no fixed-schedule order could ever generate
// its sixth day. Every 6-day package came up one delivery short with nothing
// saying so, and Julian S's 18–22 Agustus package generated four days for five
// portions. Minggu stays closed.
//
// Libur nasional is excluded too. record_daily_order has filtered closures since
// the holiday file was written, but generated schedules did not: galvent's
// package was booked straight through 25 Agustus (Maulid Nabi). Cuti bersama is
// deliberately not filtered — whether the partner kitchens work those days is an
// escalation, not a closure.
function isDeliveryDay(date: Date): boolean {
  const day = date.getUTCDay();
  if (day < 1 || day > 6) return false;
  return !isClosedHoliday(formatIsoDate(date));
}

type MealShape = Pick<
  RecurringDeliveryOrder,
  | "meal_time_preference"
  | "portions_per_delivery"
  | "portions_lunch"
  | "portions_dinner"
  | "lunch_address_slot"
  | "dinner_address_slot"
>;

function getFixedMeals(order: MealShape) {
  const pref = order.meal_time_preference;
  if (pref === "lunch_only" || pref === "default_lunch") {
    return [
      {
        address_slot: order.lunch_address_slot ?? 1,
        meal_type: "lunch" as const,
        portions: order.portions_lunch || order.portions_per_delivery || 1,
      },
    ];
  }
  if (pref === "dinner_only" || pref === "default_dinner") {
    return [
      {
        address_slot: order.dinner_address_slot ?? 1,
        meal_type: "dinner" as const,
        portions: order.portions_dinner || order.portions_per_delivery || 1,
      },
    ];
  }
  if (pref === "both_fixed") {
    return [
      {
        address_slot: order.lunch_address_slot ?? 1,
        meal_type: "lunch" as const,
        portions: order.portions_lunch || order.portions_per_delivery || 1,
      },
      {
        address_slot: order.dinner_address_slot ?? 1,
        meal_type: "dinner" as const,
        portions: order.portions_dinner || order.portions_per_delivery || 1,
      },
    ];
  }
  return [];
}

/**
 * The portions a fixed schedule actually yields between two dates. The model
 * does this arithmetic in prose and gets it wrong: Nadya asked for "paket
 * personal 20 hari" from 10 Agustus to 8 September — exactly 20 delivery days —
 * and was sold 22 porsi while 20 rows were written. The schedule is the order,
 * so count it rather than trusting the sentence.
 */
export function portionsInRange(
  order: MealShape,
  startIso: string,
  endIso: string,
): number | null {
  const meals = getFixedMeals(order);
  if (meals.length === 0) return null;
  const portionsPerDay = meals.reduce((sum, meal) => sum + meal.portions, 0);
  if (portionsPerDay <= 0) return null;

  let days = 0;
  const end = parseIsoDate(endIso);
  for (
    const date = parseIsoDate(startIso);
    date <= end;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    if (isDeliveryDay(date)) days += 1;
  }
  return days > 0 ? days * portionsPerDay : null;
}

export function buildRecurringDeliveryRows(
  order: RecurringDeliveryOrder,
  today = new Date().toISOString().slice(0, 10),
): DeliveryRow[] {
  if (!order.customer_id || !order.start_date) return [];

  const meals = getFixedMeals(order);
  if (meals.length === 0) return [];

  const portionsPerDay = meals.reduce((sum, meal) => sum + meal.portions, 0);
  if (portionsPerDay <= 0) return [];

  const rows: DeliveryRow[] = [];
  const start = parseIsoDate(order.start_date);

  if (order.end_date) {
    const end = parseIsoDate(order.end_date);
    // The date range is what the customer asked for; the package is what they
    // bought, and the range can be longer. This branch used to fill every
    // delivery day between the two and ignore package_size, so a replay on
    // 2026-08-19 wrote 10 rows against Fidela's 8-porsi order — over-drawn the
    // moment it was created. A package_size of 0 is the import artifact 72
    // customers still carry, so it caps nothing.
    let budget = (order.package_size ?? 0) > 0 ? order.package_size : null;
    for (
      const date = new Date(start);
      date <= end && (budget === null || budget >= portionsPerDay);
      date.setUTCDate(date.getUTCDate() + 1)
    ) {
      if (!isDeliveryDay(date)) continue;
      const deliveryDate = formatIsoDate(date);
      if (budget !== null) budget -= portionsPerDay;
      for (const meal of meals) {
        rows.push({
          address_slot: meal.address_slot,
          customer_id: order.customer_id,
          delivery_date: deliveryDate,
          meal_type: meal.meal_type,
          order_id: order.order_id,
          portions: meal.portions,
          status: deliveryDate < today ? "delivered" : "scheduled",
          subcontractor_id: order.subcontractor_id,
        });
      }
    }
    return rows;
  }

  let remaining = order.package_size ?? 0;
  for (
    const date = new Date(start);
    remaining >= portionsPerDay;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    if (!isDeliveryDay(date)) continue;
    const deliveryDate = formatIsoDate(date);
    for (const meal of meals) {
      rows.push({
        address_slot: meal.address_slot,
        customer_id: order.customer_id,
        delivery_date: deliveryDate,
        meal_type: meal.meal_type,
        order_id: order.order_id,
        portions: meal.portions,
        status: deliveryDate < today ? "delivered" : "scheduled",
        subcontractor_id: order.subcontractor_id,
      });
    }
    remaining -= portionsPerDay;
  }

  return rows;
}
