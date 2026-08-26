import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/**
 * The deduplicated, sorted union of `delivery_areas` over subcontractor rows
 * already in hand. Four call sites had written this same flatMap/Set/sort out
 * by hand.
 */
export function unionAreas(
  rows: { delivery_areas?: unknown }[] | null | undefined,
): string[] {
  return [
    ...new Set(
      (rows ?? []).flatMap((s) => (s.delivery_areas as string[] | null) ?? []),
    ),
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
