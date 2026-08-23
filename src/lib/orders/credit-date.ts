/**
 * The ledger date for a package credit: the day the quota arrived.
 *
 * Not `start_date`, which is the day the package starts *running*. Dating the
 * credit by it put galvent's 19 August purchase on the 20th, below the
 * deliveries that draw from it, and put Veronica's 23 August purchase on the
 * 26th — the running balance went negative for three days on quota she had
 * already paid for.
 *
 * Not `created_at` alone either. 182 of 451 orders carry a `created_at` later
 * than their `start_date`: those are the legacy customers migrated in bulk, and
 * the timestamp is the migration, not the sale. Dating those credits by it
 * files a May package after its own June draws.
 *
 * Earliest of the two is right in both directions, because a package cannot
 * have been bought after it started delivering.
 */
export function packageCreditDate(order: {
  created_at?: string | null;
  start_date?: string | null;
}): string {
  const created = (order.created_at ?? "").slice(0, 10);
  const start = (order.start_date ?? "").slice(0, 10);
  if (!created) return start;
  if (!start) return created;
  return start < created ? start : created;
}
