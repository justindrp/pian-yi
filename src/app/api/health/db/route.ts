import { createAdminClient } from "@/lib/supabase/admin";

// Readiness, as opposed to the liveness check at /api/health.
//
// /api/health answers 200 without touching anything, which is right for
// Railway's healthcheckPath — a failing deploy-time check would roll back a
// perfectly good release just because a vendor was down. But it also meant that
// on 2026-08-18, when Supabase's REST layer wedged for 15 minutes and every
// dashboard page hung on a spinner, the health endpoint stayed green the whole
// way through. Nothing could have paged anyone.
//
// This route actually reads a row, so it goes red when the app cannot serve.
// Point the uptime monitor here, not at /api/health.
export async function GET() {
  const started = Date.now();
  try {
    const db = createAdminClient();
    // Cheapest real read available: one indexed column, one row. The point is
    // to exercise PostgREST → Postgres, not to fetch anything useful.
    const { error } = await db.from("settings").select("key").limit(1).single();
    const latencyMs = Date.now() - started;
    if (error) {
      console.error("[health/db] query failed:", error.message);
      return Response.json(
        { ok: false, error: error.message, latencyMs },
        { status: 503 },
      );
    }
    return Response.json({ ok: true, latencyMs });
  } catch (err) {
    // A wedged PostgREST hangs rather than erroring, so this is mostly the
    // fetch timing out. Either way it is not serving.
    const latencyMs = Date.now() - started;
    console.error("[health/db] unreachable:", err);
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "unreachable",
        latencyMs,
      },
      { status: 503 },
    );
  }
}

export const dynamic = "force-dynamic";
