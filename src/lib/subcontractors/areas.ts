import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/**
 * `delivery_areas` as a list of area names, whatever the column actually holds.
 *
 * The column is jsonb, so it can hold anything that is valid JSON, and on
 * 2026-09-14 one row held `{}` — migration 113 wrote the Postgres array literal
 * into a jsonb column. `?? []` does not catch an object, so `.join` and `.some`
 * threw and the Settings Subcontractors tab went blank for every admin over a
 * kitchen nobody has used since Desember 2025. Migration 115 fixed the row and
 * constrained the column; this is what keeps a screen alive if one ever gets
 * past it again. Non-string entries are dropped rather than rendered.
 */
export function asAreas(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is string => typeof a === "string");
}

/**
 * The deduplicated, sorted union of `delivery_areas` over subcontractor rows
 * already in hand. Four call sites had written this same flatMap/Set/sort out
 * by hand.
 */
export function unionAreas(
  rows: { delivery_areas?: unknown }[] | null | undefined,
): string[] {
  return [
    ...new Set((rows ?? []).flatMap((s) => asAreas(s.delivery_areas))),
  ].sort();
}

/**
 * The areas Pian Yi can deliver to right now: the union of `delivery_areas`
 * across every subcontractor with `is_active = true`, deduplicated and sorted.
 *
 * Coverage belongs to the kitchen, not to the company. Each row carries its own
 * list, the lists overlap in part and differ in part, and the union moves
 * whenever a kitchen is activated, deactivated or edited — so there is no
 * correct place to write these strings down. Eleven places had written them
 * down anyway and they had drifted apart: three dashboard dropdowns offered
 * Bintaro and Graha Raya (served by nobody) while omitting Karawaci (served),
 * so a Karawaci customer could not be filed from the Customers page at all.
 *
 * Call this instead of typing an area list. Never cache the result across a
 * request.
 */
export async function activeDeliveryAreas(db: Db): Promise<string[]> {
  const { data, error } = await db
    .from("subcontractors")
    .select("delivery_areas")
    .eq("is_active", true);

  if (error) throw new Error(`activeDeliveryAreas: ${error.message}`);

  return unionAreas(data);
}

/**
 * Every area name any kitchen has ever been given, active or not.
 *
 * Not a coverage list — never offer this to a customer. It is the vocabulary
 * for the two screens that *define* coverage: the subcontractor editor, which
 * cannot derive its own options from the thing it is editing, and the
 * neighborhood editor, which must still show rows filed under an area whose
 * only kitchen has since been deactivated.
 */
export async function knownDeliveryAreas(db: Db): Promise<string[]> {
  const { data, error } = await db
    .from("subcontractors")
    .select("delivery_areas");

  if (error) throw new Error(`knownDeliveryAreas: ${error.message}`);

  return unionAreas(data);
}
