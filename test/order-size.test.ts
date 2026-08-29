import { kitchenCostPerPortion, normalizeSize } from "@/lib/orders/size";

const rates = (
  base: number | null,
  route1: number | null,
  baseM: number | null,
  route1M: number | null,
) => ({
  cost_per_portion: base,
  cost_per_portion_route1: route1,
  cost_per_portion_m: baseM,
  cost_per_portion_route1_m: route1M,
});

describe("normalizeSize", () => {
  test("reads the two sizes the column holds", () => {
    expect(normalizeSize("s")).toBe("s");
    expect(normalizeSize("m")).toBe("m");
  });

  test("treats anything else as S", () => {
    // The model fills this field, and a legacy order may carry null. S is the
    // safe read either way: an M order priced as S is too cheap by one
    // surcharge, where an S order priced as M overcharges a real customer.
    expect(normalizeSize(null)).toBe("s");
    expect(normalizeSize(undefined)).toBe("s");
    expect(normalizeSize("")).toBe("s");
    expect(normalizeSize("large")).toBe("s");
  });

  test("ignores case and stray whitespace", () => {
    expect(normalizeSize(" M ")).toBe("m");
    expect(normalizeSize("M")).toBe("m");
  });
});

describe("kitchenCostPerPortion", () => {
  test("bills route 1 at the cheaper own-courier rate", () => {
    const sub = rates(24000, 23000, null, null);
    expect(kitchenCostPerPortion(sub, "s", 1)).toBe(23000);
    expect(kitchenCostPerPortion(sub, "s", 2)).toBe(24000);
  });

  test("charges one rate on both routes when there is no route-1 override", () => {
    const sub = rates(24000, null, null, null);
    expect(kitchenCostPerPortion(sub, "s", 1)).toBe(24000);
    expect(kitchenCostPerPortion(sub, "s", 2)).toBe(24000);
  });

  test("uses the M pair for an M order", () => {
    const sub = rates(21000, 20000, 24000, 23000);
    expect(kitchenCostPerPortion(sub, "m", 1)).toBe(23000);
    expect(kitchenCostPerPortion(sub, "m", 2)).toBe(24000);
  });

  test("falls back to the kitchen's M rate on route 1, never to its S one", () => {
    // A kitchen that quoted a single M price bills it on both routes. Reading
    // its S route-1 rate here would cost every M portion our own courier
    // carries at the S price and report a margin that wide.
    const sub = rates(21000, 20000, 24000, null);
    expect(kitchenCostPerPortion(sub, "m", 1)).toBe(24000);
  });

  test("prices M at the S rate for a kitchen that has no M rate on file", () => {
    // offers_size_m is what decides whether M may be sold at all; a kitchen
    // that somehow has an M order and no M rate is costed, not zeroed.
    const sub = rates(21000, 20000, null, null);
    expect(kitchenCostPerPortion(sub, "m", 1)).toBe(20000);
    expect(kitchenCostPerPortion(sub, "m", 2)).toBe(21000);
  });

  test("reads a missing kitchen rate as zero rather than NaN", () => {
    const sub = rates(null, null, null, null);
    expect(kitchenCostPerPortion(sub, "s", 1)).toBe(0);
    expect(kitchenCostPerPortion(sub, "m", 2)).toBe(0);
  });
});
