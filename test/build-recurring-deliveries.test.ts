import { buildRecurringDeliveryRows } from "@/lib/orders/build-recurring-deliveries";

const base = {
  customer_id: "c1",
  order_id: "o1",
  subcontractor_id: "s1",
  meal_time_preference: "both_fixed",
  portions_per_delivery: 1,
  lunch_address_slot: 1,
  dinner_address_slot: 1,
  portions_lunch: 1,
  portions_dinner: 1,
  start_date: "2026-07-27",
  end_date: "2026-07-31",
};

describe("buildRecurringDeliveryRows", () => {
  it("never writes more portions than the package holds", () => {
    // Fidela asked for lunch + dinner across 27-31 Juli (5 delivery days, 10
    // portions) against an 8-porsi package. The range used to win and the order
    // was over-drawn the moment it was created.
    const rows = buildRecurringDeliveryRows(
      { ...base, package_size: 8 },
      "2026-08-19",
    );
    const portions = rows.reduce((sum, r) => sum + r.portions, 0);
    expect(portions).toBe(8);
  });

  it("stops at the end date when the package is larger than the range", () => {
    const rows = buildRecurringDeliveryRows(
      { ...base, package_size: 40 },
      "2026-08-19",
    );
    const portions = rows.reduce((sum, r) => sum + r.portions, 0);
    expect(portions).toBe(10);
    expect(rows.every((r) => r.delivery_date <= "2026-07-31")).toBe(true);
  });

  it("caps nothing for the package_size 0 import artifact", () => {
    const rows = buildRecurringDeliveryRows(
      { ...base, package_size: 0 },
      "2026-08-19",
    );
    expect(rows.reduce((sum, r) => sum + r.portions, 0)).toBe(10);
  });
});
