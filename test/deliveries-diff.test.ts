import { diffSheets, previousDeliveryDay } from "@/lib/deliveries/diff";

const row = (
  customer_id: string,
  meal_type: string,
  portions: number,
  name = customer_id,
) => ({ customer_id, meal_type, portions, customers: { name } });

describe("previousDeliveryDay", () => {
  it("steps back one working day", () => {
    expect(previousDeliveryDay("2026-09-02")).toBe("2026-09-01");
  });

  it("skips Minggu", () => {
    // 2026-09-07 is a Monday.
    expect(previousDeliveryDay("2026-09-07")).toBe("2026-09-05");
  });
});

describe("diffSheets", () => {
  it("names who started, who stopped, and who changed size", () => {
    const before = [row("a", "lunch", 6), row("b", "lunch", 1), row("c", "dinner", 2)];
    const after = [row("b", "lunch", 1), row("c", "dinner", 3), row("d", "lunch", 1)];
    const d = diffSheets(before, after);

    expect(d.added.map((e) => e.customerId)).toEqual(["d"]);
    expect(d.removed.map((e) => e.customerId)).toEqual(["a"]);
    expect(d.changed).toEqual([
      expect.objectContaining({ customerId: "c", before: 2, after: 3 }),
    ]);
    expect(d.beforePortions).toBe(9);
    expect(d.afterPortions).toBe(5);
  });

  it("keeps the two meals apart", () => {
    const d = diffSheets([row("a", "lunch", 2)], [row("a", "dinner", 2)]);
    expect(d.added.map((e) => e.mealType)).toEqual(["dinner"]);
    expect(d.removed.map((e) => e.mealType)).toEqual(["lunch"]);
    expect(d.changed).toEqual([]);
  });

  it("sums two orders drawn on the same meal", () => {
    const d = diffSheets([row("a", "lunch", 1)], [row("a", "lunch", 1), row("a", "lunch", 2)]);
    expect(d.changed).toEqual([
      expect.objectContaining({ customerId: "a", before: 1, after: 3 }),
    ]);
  });
});
