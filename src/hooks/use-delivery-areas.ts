"use client";

import { useQuery } from "@tanstack/react-query";

/**
 * The delivery areas, read from the subcontractors table rather than typed.
 *
 * `active` (default) is the union of `delivery_areas` across kitchens with
 * `is_active = true` — the answer to "do we deliver there". `known` is every
 * area name any kitchen has ever carried, for the screens that define coverage
 * rather than consume it.
 *
 * Four dashboards used to hold their own literal list. They had drifted:
 * Customers and Settings both offered Bintaro and Graha Raya, which no active
 * kitchen serves, and neither offered Karawaci, which one does — so a Karawaci
 * customer could not be filed at all.
 */
export function useDeliveryAreas(
  scope: "active" | "known" = "active",
): string[] {
  const { data } = useQuery({
    queryKey: ["delivery-areas", scope],
    queryFn: async (): Promise<string[]> => {
      const res = await fetch(`/api/areas?scope=${scope}`);
      const json = await res.json();
      return json.data ?? [];
    },
    staleTime: 5 * 60_000,
  });
  return data ?? [];
}

/**
 * The options for a field that already holds a value, plus that value.
 *
 * A customer filed under an area we have since stopped serving still has to
 * render — dropping their area from the list would silently blank it on the
 * next save.
 */
export function withCurrentAreas(
  areas: string[],
  ...current: (string | null | undefined)[]
): string[] {
  return [
    ...new Set([...areas, ...current.filter((a): a is string => !!a)]),
  ].sort();
}
