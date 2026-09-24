import { NextResponse } from "next/server";
import { getNeighborhoodPoints } from "@/lib/cache/settings";
import { catalogAreas, loadCatalog, slugify } from "@/lib/catalog/kitchens";
import { matchArea } from "@/lib/catalog/locate";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST { lat, lng } → { ok, data: { area, slug } | null }. Public: the
 * catalog calls it when a visitor allows location on open.
 *
 * The position is used for one comparison and dropped. It is never stored,
 * never logged — not even on an error — and never sent anywhere else; the
 * page rounds it to about 100 m before it leaves the phone.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as {
      lat?: unknown;
      lng?: unknown;
    } | null;
    const lat = body?.lat;
    const lng = body?.lng;
    if (
      typeof lat !== "number" ||
      typeof lng !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return NextResponse.json(
        { ok: false, error: "Invalid position" },
        { status: 400 },
      );
    }

    const [points, kitchens] = await Promise.all([
      getNeighborhoodPoints(),
      loadCatalog(createAdminClient()),
    ]);
    const area = matchArea(points, catalogAreas(kitchens), lat, lng);
    return NextResponse.json({
      ok: true,
      data: area ? { area, slug: slugify(area) } : null,
    });
  } catch (err) {
    console.error(
      "[catalog/locate] failed:",
      err instanceof Error ? err.message : "unknown",
    );
    return NextResponse.json(
      { ok: false, error: "Internal error" },
      { status: 500 },
    );
  }
}
