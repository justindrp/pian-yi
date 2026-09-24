/**
 * Which of our areas a visitor's position falls in, for the catalog's
 * "Antar ke" picker (docs/ORDER_SITE.md, "Location on open").
 *
 * Areas have no borders we can draw — the Tangerang ones are developer
 * townships, not districts — so the answer is the area of the nearest
 * neighbourhood we have a point for. Too far from all of them, nearest to an
 * excluded one, or nearest to one whose area no active kitchen serves, and the
 * answer is "not served", never the nearest area that is.
 */

export interface NeighborhoodPoint {
  area: string;
  excluded: boolean;
  lat: number;
  lng: number;
}

/**
 * Past this, the nearest neighbourhood is not where the visitor is. The
 * Jakarta areas are whole cities held by ten-odd points each, so this is
 * wider than a township's own radius.
 */
export const MAX_KM = 4;

function km(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function matchArea(
  points: NeighborhoodPoint[],
  served: string[],
  lat: number,
  lng: number,
  maxKm = MAX_KM,
): string | null {
  let best: NeighborhoodPoint | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const d = km(lat, lng, p.lat, p.lng);
    if (d < bestKm) {
      best = p;
      bestKm = d;
    }
  }
  if (!best || bestKm > maxKm || best.excluded) return null;
  return served.includes(best.area) ? best.area : null;
}
