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

function parseIsoDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isWeekday(date: Date): boolean {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

function getFixedMeals(order: RecurringDeliveryOrder) {
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
    for (
      const date = new Date(start);
      date <= end;
      date.setUTCDate(date.getUTCDate() + 1)
    ) {
      if (!isWeekday(date)) continue;
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
    }
    return rows;
  }

  let remaining = order.package_size ?? 0;
  for (
    const date = new Date(start);
    remaining >= portionsPerDay;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    if (!isWeekday(date)) continue;
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
