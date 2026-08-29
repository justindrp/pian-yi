const ROUTE_BY_AREA: Record<string, number> = {
  "Alam Sutera": 1,
  "BSD Lama": 1,
  "Gading Serpong": 2,
  "BSD Baru": 2,
  Karawaci: 2,
};

export function getDeliveryRoute(
  area: string | null | undefined,
): number | null {
  if (!area) return null;
  return ROUTE_BY_AREA[area] ?? null;
}

/**
 * Stamps `delivery_route` onto any customer patch that moves `area`.
 *
 * `customers.delivery_route` is stored, not computed at read time — the daily
 * sheet and `/dapur/[id]` group on the stored column — so a customer who
 * changes area keeps the route of the area they left. Sherine Fayola moved
 * from BSD Lama to Gading Serpong on 2026-08-26 and stayed on Route 1, which
 * is the courier we run ourselves and the cheaper of the two rates: the wrong
 * route is a wrong bill as well as a wrong van. Every create path already
 * stamped the route; no update path did.
 *
 * An explicit `delivery_route` in the same patch wins, because that is an
 * admin overriding the map on purpose (the Deliveries page route picker).
 * A patch that does not touch `area` is returned untouched, so a manual
 * override survives until the customer actually moves.
 *
 * An area with no entry in the map yields null — unassigned, the same answer
 * the create paths give. 14 customers sit in areas the map does not know
 * (Ayodhya, Bintaro, Cisauk, Graha Raya), so editing one of those addresses
 * clears a route that was set by hand. That is the honest answer: the route
 * for an unmapped area is not knowable from the area.
 */
export function withDeliveryRoute<T extends Record<string, unknown>>(
  patch: T,
): T {
  if (!("area" in patch)) return patch;
  if ("delivery_route" in patch) return patch;
  return {
    ...patch,
    delivery_route: getDeliveryRoute(patch.area as string | null | undefined),
  };
}

export function formatIDR(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(amount);
}

export function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `****${phone.slice(-4)}`;
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(date));
}

export function formatDateTime(date: string | Date): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

/**
 * A last-message stamp for a list row: the clock for today, "Kemarin" for
 * yesterday, the day and month for anything older.
 *
 * `formatDateTime` is seventeen characters ("29 Agu 2026 13.46") and does not
 * fit beside a truncated message preview in a 288px thread column. The year is
 * dropped for the same reason — an inbox row is scanned for recency, and
 * anything old enough for the year to matter reads as "old" from the date.
 */
export function formatThreadTime(date: string | Date): string {
  const d = new Date(date);
  const midnight = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  // Calendar days apart, not 24-hour blocks: a message at 23:50 last night is
  // "Kemarin" at 00:10 this morning, not "10 minutes ago rounded to today".
  const days = Math.round((midnight(new Date()) - midnight(d)) / 86_400_000);

  if (days === 0)
    return new Intl.DateTimeFormat("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  if (days === 1) return "Kemarin";
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
  }).format(d);
}
