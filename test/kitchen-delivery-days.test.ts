import { daysLabel, kitchenDeliversOn } from "@/lib/subcontractors/days";

describe("kitchenDeliversOn", () => {
  // 2026-09-04 Jumat, 2026-09-05 Sabtu, 2026-09-06 Minggu, 2026-09-07 Senin.
  it("refuses a Sabtu for a kitchen that works Senin–Jumat", () => {
    expect(kitchenDeliversOn([1, 2, 3, 4, 5], "2026-09-05")).toBe(false);
    expect(kitchenDeliversOn([1, 2, 3, 4, 5], "2026-09-04")).toBe(true);
  });

  it("allows a Sabtu for a kitchen that works Senin–Sabtu", () => {
    expect(kitchenDeliversOn([1, 2, 3, 4, 5, 6], "2026-09-05")).toBe(true);
  });

  it("treats Minggu as ISO day 7, not day 0", () => {
    expect(kitchenDeliversOn([1, 2, 3, 4, 5, 6], "2026-09-06")).toBe(false);
    expect(kitchenDeliversOn([7], "2026-09-06")).toBe(true);
  });

  it("constrains nothing when the kitchen has not said which days", () => {
    expect(kitchenDeliversOn(null, "2026-09-05")).toBe(true);
    expect(kitchenDeliversOn([], "2026-09-06")).toBe(true);
  });
});

describe("daysLabel", () => {
  it("collapses a contiguous run and lists anything else", () => {
    expect(daysLabel([1, 2, 3, 4, 5, 6])).toBe("Senin–Sabtu");
    expect(daysLabel([1, 2, 3, 4, 5])).toBe("Senin–Jumat");
    expect(daysLabel([1, 3, 5])).toBe("Senin, Rabu, Jumat");
    expect(daysLabel([])).toBe("");
  });
});
