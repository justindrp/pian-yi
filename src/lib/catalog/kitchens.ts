import type { SupabaseClient } from "@supabase/supabase-js";
import { getSetting } from "@/lib/cache/settings";
import { sizeMSurcharge } from "@/lib/orders/size";
import {
  laddersForKitchens,
  type PriceTier,
  priceForPortions,
} from "@/lib/pricing/tiers";
import { asAreas } from "@/lib/subcontractors/areas";
import { daysLabel } from "@/lib/subcontractors/days";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

// The public number customers message. Not the phone_number_id — that is an
// internal Meta handle and means nothing in a wa.me link.
export const WA_NUMBER = "6285111214390";
export const WA_DISPLAY = "+62 851-1121-4390";

// The legal identity Meta business verification matches against the OSS record.
// A brand is not a legal entity: this stays the NIB holder's registered name
// whatever the storefront is called.
export const LEGAL_NAME = "Pian Yi Catering";
// What customers see: the storefront name on every public page.
export const BRAND = "Katerloka";
export const NIB = "2307250135661";
// The registered address on the OSS record, printed with the legal name.
export const ADDRESS = {
  street:
    "Jl. Palm Kuning IV Blok BE/06 Sekt.1-3, RT 002/RW 007, Kel. Rawabuntu, Kec. Serpong",
  city: "Kota Tangerang Selatan",
  region: "Banten",
  postalCode: "15318",
  country: "ID",
};
export const CONTACT_EMAIL = "drpramadyo@gmail.com";

/**
 * A click-to-chat link that opens WhatsApp with `text` already typed.
 *
 * Every catalog page ends here rather than in a form that collects a phone
 * number: the WABA's 131042 restriction means we cannot write first to a number
 * that has not written to us, so the customer has to open the conversation.
 * The text names what they were looking at, so the bot starts already knowing.
 */
export function chatLink(text?: string): string {
  const base = `https://wa.me/${WA_NUMBER}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

/** "Dapur Suplir" → "suplir", "BSD Baru" → "bsd-baru". */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/^dapur\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export type Rung = { price: number; min: number; max: number };

/**
 * Collapse a ladder into the handful of prices that actually exist. Five, six,
 * ten and twelve portions are four rows in the database but only two prices,
 * and a customer comparing caterers wants the prices. Derived, never written
 * down, so a new tier appears by itself.
 */
export function toRungs(tiers: PriceTier[]): Rung[] {
  const rungs: Rung[] = [];
  for (const tier of [...tiers].sort((a, b) => a.portions - b.portions)) {
    const last = rungs.at(-1);
    if (last && last.price === tier.price_per_portion) {
      last.max = tier.portions;
    } else {
      rungs.push({
        price: tier.price_per_portion,
        min: tier.portions,
        max: tier.portions,
      });
    }
  }
  return rungs;
}

/**
 * One kitchen as the public sees it. Deliberately no id and no real name: the
 * catalog is one paste into a search engine away from undoing kitchen
 * anonymity, so nothing that could identify a kitchen is ever handed to a page.
 */
export type CatalogKitchen = {
  nickname: string;
  slug: string;
  days: number[];
  daysLabel: string;
  areas: string[];
  tiers: PriceTier[];
  rungs: Rung[];
  /** The cheapest per-portion price this kitchen sells at. */
  from: number;
  /** Per-portion tambahan for size M, or null when this kitchen does not cook M. */
  sizeM: number | null;
  /** Per-portion discount for tanpa nasi; 0 when nothing comes off. */
  noRiceOff: number;
  /** One public line on the food and delivery (`catalog_blurb`); null shows nothing. */
  blurb: string | null;
};

/**
 * Every active kitchen that can be shown: it has a customer nickname and a
 * ladder. A kitchen with no nickname is skipped rather than shown under any
 * other label — the real name is never a fallback — and one with no ladder has
 * no price to publish. Sorted cheapest first.
 */
export async function loadCatalog(db: Db): Promise<CatalogKitchen[]> {
  const { data, error } = await db
    .from("subcontractors")
    .select(
      "id, customer_nickname, catalog_blurb, delivery_days, delivery_areas, offers_size_m, size_m_surcharge, no_rice_discount",
    )
    .eq("is_active", true);
  if (error) throw new Error(`loadCatalog: ${error.message}`);

  const rows = (data ?? []).filter((k) => k.customer_nickname?.trim());
  const ladders = await laddersForKitchens(
    db,
    rows.map((k) => k.id),
  );

  const kitchens: CatalogKitchen[] = [];
  for (const row of rows) {
    const tiers = ladders.get(row.id) ?? [];
    if (tiers.length === 0) continue;
    const nickname = (row.customer_nickname ?? "").trim();
    kitchens.push({
      nickname,
      slug: slugify(nickname),
      days: row.delivery_days,
      daysLabel: daysLabel(row.delivery_days),
      areas: asAreas(row.delivery_areas).sort(),
      tiers,
      rungs: toRungs(tiers),
      from: Math.min(...tiers.map((t) => t.price_per_portion)),
      sizeM: row.offers_size_m ? await sizeMSurcharge(row) : null,
      noRiceOff:
        typeof row.no_rice_discount === "number" && row.no_rice_discount > 0
          ? row.no_rice_discount
          : 0,
      blurb: row.catalog_blurb?.trim() || null,
    });
  }
  return kitchens.sort((a, b) => a.from - b.from);
}

/** Every area at least one shown kitchen serves, sorted. */
export function catalogAreas(kitchens: CatalogKitchen[]): string[] {
  return [...new Set(kitchens.flatMap((k) => k.areas))].sort();
}

/**
 * The comparison grid for `/harga`: one row per band of portion counts, one
 * price per kitchen. Bands come from the union of every ladder's listed sizes,
 * each priced by the same largest-tier-at-or-below rule the order path uses,
 * and consecutive bands where no kitchen's price changes are merged — so the
 * table has exactly as many rows as there are distinct price steps.
 */
export function compareRows(
  kitchens: CatalogKitchen[],
): { min: number; max: number; prices: (number | null)[] }[] {
  const sizes = [
    ...new Set(kitchens.flatMap((k) => k.tiers.map((t) => t.portions))),
  ].sort((a, b) => a - b);
  const rows: { min: number; max: number; prices: (number | null)[] }[] = [];
  for (const size of sizes) {
    const prices = kitchens.map((k) => priceForPortions(k.tiers, size));
    const last = rows.at(-1);
    if (last?.prices.every((p, i) => p === prices[i])) {
      last.max = size;
    } else {
      rows.push({ min: size, max: size, prices });
    }
  }
  return rows;
}

/** The hour orders close the day before, from `settings.order_deadline_hour`. */
export async function orderDeadlineLabel(): Promise<string> {
  const hour = Number(await getSetting("order_deadline_hour"));
  const h = Number.isFinite(hour) && hour > 0 ? hour : 16;
  return `${String(h).padStart(2, "0")}.00`;
}

export const rupiah = (n: number) => n.toLocaleString("id-ID");

export const porsiRange = (min: number, max: number) =>
  min === max ? `${min} porsi` : `${min}–${max} porsi`;
