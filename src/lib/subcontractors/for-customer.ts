import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Db = SupabaseClient<Database>;

/** The columns every customer-facing kitchen decision needs. */
const KITCHEN_COLUMNS =
  "id, customer_nickname, menu_image_url, menu_text, menu_week_start, price_list_image_url, delivery_areas, delivery_days, offers_size_m, same_menu_both_meals, lunch_window_start_min, lunch_window_end_min, dinner_window_start_min, dinner_window_end_min";

export type CustomerKitchen = {
  id: string;
  customer_nickname: string | null;
  menu_image_url: string | null;
  menu_text: string | null;
  menu_week_start: string | null;
  price_list_image_url: string | null;
  delivery_areas: unknown;
  delivery_days: number[];
  offers_size_m: boolean;
  same_menu_both_meals: boolean;
  lunch_window_start_min: number | null;
  lunch_window_end_min: number | null;
  dinner_window_start_min: number | null;
  dinner_window_end_min: number | null;
};

function serves(kitchen: CustomerKitchen, areas: string[]): boolean {
  if (areas.length === 0) return true;
  const own = (kitchen.delivery_areas as string[] | null) ?? [];
  return own.some((a) => areas.includes(a));
}

/**
 * The kitchens a given customer may be shown and quoted from, narrowed as far
 * as what we know about them allows.
 *
 * Everything customer-facing used to be global, because one kitchen cooked
 * everything: one menu image, one price list, one set of delivery hours. Since
 * migration 098 each kitchen carries its own ladder — the house bottom tier is
 * Rp 29.000 against Dapur Monstera's Rp 45.000 — so sending "the" price list or
 * looping every active kitchen's menu quotes a customer prices for food nobody
 * will cook for them, off by up to Rp 16.000 a portion.
 *
 * Three narrowings, most specific first:
 *
 *   1. `customers.subcontractor_id` — the kitchen already assigned to them,
 *      by an admin or by the order they placed. Their food comes from there,
 *      so it is the only menu and the only ladder that applies. An assignment
 *      to a kitchen that has since gone inactive is ignored rather than
 *      returned, or the customer is shown a menu nobody is cooking.
 *   2. their area — the active kitchens whose own `delivery_areas` covers
 *      where they live. This is the "customer picks" case: an area served by
 *      three kitchens shows three, and the customer chooses.
 *   3. nothing known yet — every active kitchen, which is what a first
 *      contact who has not said where they are gets.
 *
 * Never write an area or a kitchen list into a prompt from anywhere else: the
 * lists move whenever a kitchen is activated, deactivated or edited.
 */
/**
 * The active kitchens whose own `delivery_areas` covers where this customer
 * lives — their assignment deliberately ignored.
 *
 * `kitchensForCustomer` narrows to the kitchen already cooking for them, which
 * is right for sending a menu or a price list: one customer, one menu. It is
 * wrong for the prompt's dapur list, which has to keep every kitchen the
 * customer may *choose* between, including the ones they have never bought
 * from and the ones they might mix into a package.
 *
 * Area is still a hard narrowing, and it is why this exists: the prompt used
 * to list every active kitchen, so on 2026-09-06, when Santapin's couriers
 * filled up outside Bintaro and their `delivery_areas` was cut to Bintaro
 * alone, nothing changed for a lead in BSD — the bot went on offering that
 * dapur, quoting its ladder and selling days it could not deliver. The area
 * lists only reach a customer if something reads them.
 *
 * An area no active kitchen covers falls back to every active kitchen, the
 * same way `kitchensForCustomer` does: a data gap is not a reason to show the
 * customer nothing.
 */
export async function kitchensForCustomerArea(
  db: Db,
  customerId: string,
): Promise<CustomerKitchen[]> {
  const [{ data: customer }, { data: activeRaw }] = await Promise.all([
    db
      .from("customers")
      .select("area, area_2")
      .eq("id", customerId)
      .maybeSingle(),
    db.from("subcontractors").select(KITCHEN_COLUMNS).eq("is_active", true),
  ]);

  const active = (activeRaw ?? []) as unknown as CustomerKitchen[];
  const areas = [customer?.area, customer?.area_2].filter(
    (a): a is string => !!a,
  );
  const covering = active.filter((k) => serves(k, areas));
  return covering.length > 0 ? covering : active;
}

export async function kitchensForCustomer(
  db: Db,
  customerId: string,
): Promise<CustomerKitchen[]> {
  const [{ data: customer }, { data: activeRaw }] = await Promise.all([
    db
      .from("customers")
      .select("subcontractor_id, area, area_2")
      .eq("id", customerId)
      .maybeSingle(),
    db.from("subcontractors").select(KITCHEN_COLUMNS).eq("is_active", true),
  ]);

  const active = (activeRaw ?? []) as unknown as CustomerKitchen[];

  if (customer?.subcontractor_id) {
    const assigned = active.find((k) => k.id === customer.subcontractor_id);
    if (assigned) return [assigned];
  }

  const areas = [customer?.area, customer?.area_2].filter(
    (a): a is string => !!a,
  );
  const covering = active.filter((k) => serves(k, areas));

  // An area no active kitchen covers is a data problem, not a reason to show
  // the customer nothing: fall back to every active kitchen and let the
  // conversation sort it out.
  return covering.length > 0 ? covering : active;
}
