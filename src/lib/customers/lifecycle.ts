const ORDER_DISPLAY_STATUSES = new Set([
  "pending_payment",
  "payment_proof_received",
  "active",
  "paused",
  "completed",
  "cancelled_unpaid",
  "cancelled_by_customer",
  "cancelled_by_admin",
  "refunded",
]);

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

export function deriveCustomerDisplayState(
  customerState: string | null | undefined,
  latestOrderStatus: string | null | undefined,
): string {
  const normalizedCustomerState = normalizeCustomerState(customerState);
  if (!latestOrderStatus || !ORDER_DISPLAY_STATUSES.has(latestOrderStatus)) {
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
