/**
 * The order statuses whose `package_size` counts as quota the customer owns.
 *
 * This is a decision, not a formula, and it is the half of a balance that can
 * be wrong. Four places net packages against delivery rows — the customer
 * ledger drawer, the Customers list column, the bot's `loadCustomerSchedule`
 * and the renewal cron's `remainingTodayByCustomer` — and each used to carry
 * its own literal. The arithmetic never drifted; this list did. The ledger and
 * the list counted `payment_proof_received` and the other two did not, so a
 * customer whose renewal was awaiting verification read as credited on the
 * Customers page and as still running out to the bot and the cron — which
 * would have messaged them "mau renewal?" right after they renewed.
 *
 * `payment_proof_received` is deliberately **out**: proof sent is not payment
 * verified. `mark_paid` is what writes `daily_deliveries` rows and nothing
 * filters the kitchen sheet by order status, so treating an unverified
 * screenshot as quota is how a forged or misread one becomes cooked food.
 * Unverified proofs are an admin's queue at `/payments`, not a balance.
 *
 * `completed` is deliberately **in**: the June import's `package_size = 0`
 * catch-all orders hold completed packages' delivery rows, so dropping their
 * credit charges food the customer paid for to the orders still open.
 *
 * Not to be confused with the list in `GET /api/customers`, which asks "has
 * this customer ever bought anything" to decide who appears on the page. That
 * one counts `payment_proof_received` on purpose — someone who just sent proof
 * must not vanish from the Customers list.
 */
export const PAID_STATUSES = ["active", "paused", "completed"];
