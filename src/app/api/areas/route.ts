import { type NextRequest, NextResponse } from "next/server";
import {
  activeDeliveryAreas,
  knownDeliveryAreas,
} from "@/lib/subcontractors/areas";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";

/**
 * The live delivery-area list for dashboard dropdowns. Admin-only: it is
 * derived from subcontractor coverage, which is internal.
 *
 * `?scope=known` widens it to every area name any kitchen has ever carried,
 * active or not — the vocabulary the subcontractor and neighborhood editors
 * need. Default is `active`, which is what "do we deliver there" means.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionWithRole();
  if (!session)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const scope =
    req.nextUrl.searchParams.get("scope") === "known" ? "known" : "active";

  try {
    const db = createAdminClient();
    const data =
      scope === "known"
        ? await knownDeliveryAreas(db)
        : await activeDeliveryAreas(db);
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to load areas";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
