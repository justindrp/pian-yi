import HandbookClient from "@/components/dashboard/handbook-client";
import { getSetting } from "@/lib/cache/settings";
import { activeDeliveryAreas } from "@/lib/subcontractors/areas";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Onboarding for a new admin. The prose is in the client component; everything
 * here is a fact that has already gone stale once somewhere else in this repo —
 * the served areas, the H-1 cutoff and the price ladder are read live so the
 * handbook cannot teach a new admin a rule the system stopped enforcing.
 */
export default async function HandbookPage() {
  const db = createAdminClient();

  const [areas, deadlineHour, tiers, kitchens] = await Promise.all([
    activeDeliveryAreas(db),
    getSetting("order_deadline_hour"),
    db
      .from("pricing_tiers")
      .select("portions, price_per_portion")
      .order("portions"),
    db
      .from("subcontractors")
      .select("customer_nickname")
      .eq("is_active", true)
      .order("customer_nickname"),
  ]);

  // getSetting returns "" for a missing key, and Number("") is 0 — which would
  // print a 00:00 cutoff rather than fail.
  const hour = Number(deadlineHour);

  return (
    <HandbookClient
      areas={areas}
      deadlineHour={Number.isFinite(hour) && hour > 0 ? hour : 16}
      tiers={tiers.data ?? []}
      nicknames={(kitchens.data ?? [])
        .map((k) => k.customer_nickname)
        .filter((n): n is string => Boolean(n))}
    />
  );
}

export const dynamic = "force-dynamic";
