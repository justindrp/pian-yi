import { jakartaDateString } from "@/lib/menu/week";

/**
 * The ledger date for a package credit: the day the quota arrived.
 *
 * Not `start_date`, which is the day the package starts *running*. Dating the
 * credit by it put galvent's 19 August purchase on the 20th, below the
 * deliveries that draw from it, and put Veronica's 23 August purchase on the
 * 26th — the running balance went negative for three days on quota she had
 * already paid for.
 *
 * `paid_at` before `created_at`, because the quota arrives when the money does,
 * not when the bot drafted the order. Naomi Natha's 20-porsi order was created
 * on 22 September and paid on the 23rd; dated by `created_at` the ledger showed
 * the package a day before she had bought it. An unpaid order, or a legacy one
 * with no `paid_at`, falls back to `created_at`.
 *
 * Not either timestamp alone. 182 of 451 orders carry a `created_at` later
 * than their `start_date`: those are the legacy customers migrated in bulk, and
 * the timestamp is the migration, not the sale. Dating those credits by it
 * files a May package after its own June draws.
 *
 * The timestamp is read in WIB: a payment marked at 06:00 WIB is still the
 * previous day in UTC.
 *
 * Earliest of that and `start_date` is right in both directions, because a
 * package cannot have been bought after it started delivering.
 */
export function packageCreditDate(order: {
  created_at?: string | null;
  paid_at?: string | null;
  start_date?: string | null;
}): string {
  const at = order.paid_at ?? order.created_at;
  const bought = at ? jakartaDateString(new Date(at)) : "";
  const start = (order.start_date ?? "").slice(0, 10);
  if (!bought) return start;
  if (!start) return bought;
  return start < bought ? start : bought;
}
