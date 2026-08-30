const CURRENT_ORDER_STATUSES = new Set([
  "pending_payment",
  "payment_proof_received",
  "active",
  "paused",
]);

export const CUSTOMER_STATES = [
  "new",
  "ordering",
  "lapsed",
  "churned",
] as const;

export type CustomerStateValue = (typeof CUSTOMER_STATES)[number];

export function normalizeCustomerState(
  state: string | null | undefined,
): CustomerStateValue {
  switch (state) {
    case "ordering":
    case "lapsed":
    case "churned":
    case "new":
      return state;
    case "browsing":
      return "new";
    case "awaiting_payment":
    case "payment_proof_received":
      return "ordering";
    case "active_subscription":
      return "new";
    default:
      return "new";
  }
}

/**
 * The badge on the Customers list: the customer's own state, overridden by the
 * status of their newest order when that order is still live.
 *
 * `latestOrderStatus` must be the newest order that is *current* — one of
 * CURRENT_ORDER_STATUSES — and never simply the newest row by `created_at`.
 * galvent held three orders created within 46 minutes on 2026-08-19: a live
 * 10-porsi package at 06:32 and two cancelled duplicates either side of it. The
 * caller passed the newest by `created_at`, so a `cancelled_by_admin` order
 * created 20 minutes *after* the live one owned her badge and the page called an
 * active customer cancelled.
 *
 * A terminal status is not a state a customer is in — `completed`, `refunded`
 * and the three cancellations all describe an order that is over, and what the
 * customer is once it is over is exactly what `customer_state` already says.
 * So terminal statuses never reach the badge; only a live order overrides.
 */
export function deriveCustomerDisplayState(
  customerState: string | null | undefined,
  latestOrderStatus: string | null | undefined,
): string {
  const normalizedCustomerState = normalizeCustomerState(customerState);
  if (!latestOrderStatus || !CURRENT_ORDER_STATUSES.has(latestOrderStatus)) {
    return normalizedCustomerState;
  }

  if (
    normalizedCustomerState === "lapsed" ||
    normalizedCustomerState === "churned"
  ) {
    return normalizedCustomerState;
  }

  return latestOrderStatus;
}

export function shouldHandlePaymentProof(
  latestOrderStatus: string | null | undefined,
): boolean {
  return latestOrderStatus === "pending_payment";
}

export function hasCurrentOrder(
  latestOrderStatus: string | null | undefined,
): boolean {
  return latestOrderStatus
    ? CURRENT_ORDER_STATUSES.has(latestOrderStatus)
    : false;
}
