// Which of a customer's active orders a delivery draws from.
//
// This used to be decided by whichever row Postgres happened to return first:
// three separate call sites queried `orders` filtered on status = 'active' with
// no ORDER BY and took element 0. Heap order is roughly insertion order, so the
// oldest active order won every time — including after it was fully drawn down,
// and including when the customer had since bought a fresh package.
//
// Julian S is the case that surfaced it. Order eb853b86 (created 07-26, pkg 5)
// took 9 deliveries while 0831e475 (created 08-04, pkg 5) took 1, because
// eb853b86 was created first and kept winning until it flipped to 'completed'
// and dropped out of the filter. 85 customers currently hold two or more active
// orders at once, so this was not a one-off.
//
// The rule: drain the oldest package that still has balance. That is what a
// prepaid quota means — the portions bought first are the portions used first —
// and it is deterministic, which the old behaviour was not.

export type DrawCandidate = {
  id: string;
  portions_remaining: number | null;
  start_date: string | null;
  created_at?: string | null;
};

function byStartDate(a: DrawCandidate, b: DrawCandidate): number {
  // A null start_date sorts last: an order nobody has dated yet is a worse
  // guess than one that plainly started.
  const as = a.start_date ?? "9999-12-31";
  const bs = b.start_date ?? "9999-12-31";
  if (as !== bs) return as < bs ? -1 : 1;
  return (a.created_at ?? "") < (b.created_at ?? "") ? -1 : 1;
}

/**
 * The order a new draw for this customer should be charged to.
 *
 * Prefers the oldest active order that still has portions left. When none does,
 * falls back to the most recently created one rather than returning null —
 * `portions_remaining` is unreliable on the June import (89 active orders read
 * zero or below, many of them stale counters rather than genuinely used up), so
 * refusing here would drop real customers out of the daily sheet. The fallback
 * at least charges the draw to the newest package instead of a June leftover.
 * Callers that need to know which happened should compare `portions_remaining`
 * on the result.
 */
export function pickDrawOrder<T extends DrawCandidate>(
  orders: readonly T[],
): T | null {
  if (orders.length === 0) return null;

  const withBalance = orders.filter((o) => (o.portions_remaining ?? 0) > 0);
  if (withBalance.length > 0) {
    return [...withBalance].sort(byStartDate)[0];
  }

  return [...orders].sort((a, b) =>
    (a.created_at ?? "") > (b.created_at ?? "") ? -1 : 1,
  )[0];
}
