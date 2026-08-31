import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

export type CoverageRule = {
  neighborhoodId: string;
  area: string;
  name: string;
  canDeliver: boolean;
  surchargePerDelivery: number;
};

/**
 * What one kitchen has said about the neighborhoods inside the areas it carries.
 *
 * `delivery_areas` is coverage at the area level, and a kitchen's own courier
 * knows finer than that: Thenie carries BSD Lama and Alam Sutera and still
 * refuses Apartemen Akasa and Kost Casa Living, and charges Rp 5.000 on some
 * BSD Lama drops. Rows exist only for the neighborhoods a kitchen has ruled on
 * — an address nobody has asked about is served at the normal rate, which is
 * how it has always worked and what an empty table has to keep meaning.
 */
export async function kitchenCoverage(
  db: Db,
  subcontractorId: string,
): Promise<CoverageRule[]> {
  const { data, error } = await db
    .from("subcontractor_neighborhoods")
    .select(
      "neighborhood_id, can_deliver, surcharge_per_delivery, area_neighborhoods(area, name)",
    )
    .eq("subcontractor_id", subcontractorId);

  if (error) throw new Error(`kitchenCoverage: ${error.message}`);

  return (data ?? []).flatMap((row) => {
    const n = row.area_neighborhoods as { area: string; name: string } | null;
    if (!n) return [];
    return [
      {
        neighborhoodId: row.neighborhood_id,
        area: n.area,
        name: n.name,
        canDeliver: row.can_deliver,
        surchargePerDelivery: row.surcharge_per_delivery ?? 0,
      },
    ];
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a neighborhood name appears in a customer's address.
 *
 * Word-boundary matched at the front, because a substring test reads "Tucasa
 * Living, Regentown" as Casa Living and would have refused a customer in a
 * different area entirely. Anchored only at the start: "Apartemen Akasa" has to
 * match "Apartemen Akasa Tower Kalyana", which is the same complex written
 * longer.
 */
export function addressMatchesNeighborhood(
  address: string,
  neighborhood: string,
): boolean {
  const name = neighborhood.trim();
  if (!name) return false;
  return new RegExp(`\\b${escapeRegex(name)}`, "i").test(address);
}

/**
 * The kitchen's verdict on one address: whether it will go, and what it adds
 * for going.
 *
 * Matched on the address text rather than on `customers.area` + `sub_area`,
 * because those two disagree with each other for the same place — the two towers
 * of Apartemen Akasa are filed under BSD Lama and BSD Baru, and Evelyn's
 * sub_area is "Pakojan" while her address is "Kost Casa Living 158". The address
 * line is the only field that reliably names the building, and it is what the
 * courier reads.
 *
 * A refusal wins over a surcharge: if any matched rule says no, the answer is
 * no. Surcharges do not stack — the largest matched one applies, since two
 * matches mean two names for one building, not two trips.
 */
export function coverageFor(
  rules: CoverageRule[],
  ...addressFields: (string | null | undefined)[]
): { blocked: CoverageRule | null; surchargePerDelivery: number } {
  const address = addressFields.filter(Boolean).join(" ");
  const matched = rules.filter((r) =>
    addressMatchesNeighborhood(address, r.name),
  );
  return {
    blocked: matched.find((r) => !r.canDeliver) ?? null,
    surchargePerDelivery: matched.reduce(
      (max, r) => (r.canDeliver ? Math.max(max, r.surchargePerDelivery) : max),
      0,
    ),
  };
}

/**
 * The same rules for several kitchens at once, keyed by subcontractor id — for
 * the prompt and the coverage editor, which both need every active kitchen's
 * list in one pass.
 */
export async function kitchenCoverageMap(
  db: Db,
  subcontractorIds?: string[],
): Promise<Record<string, CoverageRule[]>> {
  let query = db
    .from("subcontractor_neighborhoods")
    .select(
      "subcontractor_id, neighborhood_id, can_deliver, surcharge_per_delivery, area_neighborhoods(area, name)",
    );
  if (subcontractorIds) query = query.in("subcontractor_id", subcontractorIds);

  const { data, error } = await query;
  if (error) throw new Error(`kitchenCoverageMap: ${error.message}`);

  const byKitchen: Record<string, CoverageRule[]> = {};
  for (const row of data ?? []) {
    const n = row.area_neighborhoods as { area: string; name: string } | null;
    if (!n) continue;
    byKitchen[row.subcontractor_id] ??= [];
    byKitchen[row.subcontractor_id].push({
      neighborhoodId: row.neighborhood_id,
      area: n.area,
      name: n.name,
      canDeliver: row.can_deliver,
      surchargePerDelivery: row.surcharge_per_delivery ?? 0,
    });
  }
  return byKitchen;
}

export type KitchenCoverageNote = {
  /** Customer-facing nickname — never the kitchen's real name. */
  nickname: string;
  blocked: CoverageRule[];
  surcharged: CoverageRule[];
};

/**
 * The exceptions worth telling the bot about, one entry per kitchen that has
 * any. Kitchens with nothing to declare are left out, so the prompt grows only
 * when a kitchen has actually ruled on something.
 */
export async function coverageNotes(
  db: Db,
  kitchens: { id: string; customer_nickname?: string | null }[],
): Promise<KitchenCoverageNote[]> {
  if (kitchens.length === 0) return [];
  const map = await kitchenCoverageMap(
    db,
    kitchens.map((k) => k.id),
  );
  return kitchens.flatMap((k) => {
    const rules = map[k.id] ?? [];
    const blocked = rules.filter((r) => !r.canDeliver);
    const surcharged = rules.filter(
      (r) => r.canDeliver && r.surchargePerDelivery > 0,
    );
    if (blocked.length === 0 && surcharged.length === 0) return [];
    return [
      {
        nickname: k.customer_nickname ?? "dapur partner kami",
        blocked,
        surcharged,
      },
    ];
  });
}
