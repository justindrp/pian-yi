import HandbookClient from "@/components/dashboard/handbook-client";
import { getSetting } from "@/lib/cache/settings";
import { laddersForKitchens } from "@/lib/pricing/tiers";
import { activeDeliveryAreas } from "@/lib/subcontractors/areas";
import { daysLabel } from "@/lib/subcontractors/days";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Onboarding for a new admin. The prose is in the client component; everything
 * here is a fact that has already gone stale once somewhere else in this repo —
 * the served areas, the working weekdays, the H-1 cutoff and the price ladder are read live so the
 * handbook cannot teach a new admin a rule the system stopped enforcing.
 */
export default async function HandbookPage() {
  const db = createAdminClient();

  const [areas, deadlineHour, kitchens] = await Promise.all([
    activeDeliveryAreas(db),
    getSetting("order_deadline_hour"),
    db
      .from("subcontractors")
      .select("id, customer_nickname, delivery_days")
      .eq("is_active", true)
      .order("customer_nickname"),
  ]);
  // One ladder per kitchen; there is no house ladder (migration 135).
  const ladders = await laddersForKitchens(
    db,
    (kitchens.data ?? []).map((k) => k.id),
  );

  // getSetting returns "" for a missing key, and Number("") is 0 — which would
  // print a 00:00 cutoff rather than fail.
  const hour = Number(deadlineHour);

  return (
    <HandbookClient
      areas={areas}
      deadlineHour={Number.isFinite(hour) && hour > 0 ? hour : 16}
      ladders={(kitchens.data ?? [])
        .filter((k) => k.customer_nickname)
        .map((k) => ({
          nickname: k.customer_nickname as string,
          tiers: ladders.get(k.id) ?? [],
        }))}
      nicknames={(kitchens.data ?? [])
        .map((k) => k.customer_nickname)
        .filter((n): n is string => Boolean(n))}
      schedules={(kitchens.data ?? [])
        .filter((k) => k.customer_nickname)
        .map(
          (k) =>
            `${k.customer_nickname}: ${daysLabel(k.delivery_days) || "belum diisi"}`,
        )}
    />
  );
}

export const dynamic = "force-dynamic";
