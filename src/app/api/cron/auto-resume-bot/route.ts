import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

const INACTIVITY_MINUTES = 15;

export async function GET(req: NextRequest): Promise<Response> {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const cutoff = new Date(Date.now() - INACTIVITY_MINUTES * 60 * 1000).toISOString();

  const { data, error } = await db
    .from("customer_flags")
    .update({ escalated_to_human: false, escalation_reason: null, last_human_activity_at: null })
    .eq("escalated_to_human", true)
    .lt("last_human_activity_at", cutoff)
    .not("last_human_activity_at", "is", null)
    .select("customer_id");

  if (error) {
    console.error("[auto-resume-bot]", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const resumed = data?.length ?? 0;
  if (resumed > 0) {
    console.log(`[auto-resume-bot] resumed bot for ${resumed} customer(s)`);
  }

  return NextResponse.json({ ok: true, resumed });
}

export const dynamic = "force-dynamic";
