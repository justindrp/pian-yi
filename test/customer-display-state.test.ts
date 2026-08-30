import { deriveCustomerDisplayState } from "@/lib/customers/lifecycle";

/**
 * The State badge on /customers. It shows the customer's own lifecycle state,
 * overridden by their newest order's status only while that order is live.
 *
 * galvent held three orders created within 46 minutes on 2026-08-19: a live
 * 10-porsi package at 06:32, and cancelled duplicates at 06:06 and 06:52. The
 * caller took the newest by `created_at`, so the duplicate cancelled twenty
 * minutes *after* the live package owned her badge and the page called an
 * active customer "cancelled by admin". 64 customers carried a terminal status
 * as their state for the same reason, most of them `completed`.
 */
describe("deriveCustomerDisplayState", () => {
  test("a live order overrides the customer state", () => {
    expect(deriveCustomerDisplayState("new", "active")).toBe("active");
    expect(deriveCustomerDisplayState("new", "pending_payment")).toBe(
      "pending_payment",
    );
    expect(deriveCustomerDisplayState("ordering", "paused")).toBe("paused");
  });

  test("a terminal order never becomes the state", () => {
    // What the customer is once an order is over is what customer_state says.
    for (const status of [
      "completed",
      "cancelled_by_admin",
      "cancelled_unpaid",
      "cancelled_by_customer",
      "refunded",
    ]) {
      expect(deriveCustomerDisplayState("ordering", status)).toBe("ordering");
      expect(deriveCustomerDisplayState("new", status)).toBe("new");
    }
  });

  test("lapsed and churned outrank a live order", () => {
    expect(deriveCustomerDisplayState("lapsed", "active")).toBe("lapsed");
    expect(deriveCustomerDisplayState("churned", "pending_payment")).toBe(
      "churned",
    );
  });

  test("no order at all leaves the customer state alone", () => {
    expect(deriveCustomerDisplayState("ordering", null)).toBe("ordering");
    expect(deriveCustomerDisplayState(null, null)).toBe("new");
    // Legacy state names still in 51 customer_state rows.
    expect(deriveCustomerDisplayState("awaiting_payment", null)).toBe(
      "ordering",
    );
  });
});
