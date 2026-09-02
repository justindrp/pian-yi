import {
  DELIVERY_WINDOWS,
  deliveryWindow,
  windowLabel,
} from "@/lib/deliveries/windows";

const DAPUR_1 = {
  lunch_window_start_min: 690,
  lunch_window_end_min: 750,
  dinner_window_start_min: null,
  dinner_window_end_min: null,
};

describe("deliveryWindow", () => {
  it("falls back when the kitchen is unknown", () => {
    expect(deliveryWindow("lunch").label).toBe("10.00-12.00");
    expect(deliveryWindow("dinner", null).label).toBe("16.00-18.00");
  });

  // Dapur 1's courier reached Synergy at 12.00 on 2026-09-01 and its photo for
  // the next day was taken at 12.09, both against a promised 10.00-12.00.
  it("uses the kitchen's own lunch window", () => {
    expect(deliveryWindow("lunch", DAPUR_1)).toEqual({
      label: "11.30-12.30",
      startMin: 690,
      endMin: 750,
    });
  });

  // Naya asked at 11.09. By the default she was two minutes from the end of
  // her window; by her kitchen's she was 21 minutes before its start.
  it("still has the food out at 11.09 for that kitchen", () => {
    expect(11 * 60 + 9).toBeLessThan(deliveryWindow("lunch", DAPUR_1).endMin);
    expect(11 * 60 + 9).toBeGreaterThan(DELIVERY_WINDOWS.lunch.endMin - 60);
  });

  it("leaves a meal the kitchen has not set on the fallback", () => {
    expect(deliveryWindow("dinner", DAPUR_1).label).toBe("16.00-18.00");
  });

  // Half a window is not a window.
  it("ignores a kitchen with only one end recorded", () => {
    expect(
      deliveryWindow("lunch", { ...DAPUR_1, lunch_window_end_min: null }).label,
    ).toBe("10.00-12.00");
  });

  it("writes minutes the way a customer reads them", () => {
    expect(windowLabel(690, 750)).toBe("11.30-12.30");
    expect(windowLabel(600, 720)).toBe("10.00-12.00");
  });
});
