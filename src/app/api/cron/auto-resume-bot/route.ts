import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { tryLearnCustomerContext } from "@/lib/claude/learn-context";

const INACTIVITY_MINUTES = 10;

export async function GET(req: NextRequest): Promise<Response> {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const cutoff = new Date(Date.now() - INACTIVITY_MINUTES * 60 * 1000).toISOString();

  const { data: candidates, error: selectError } = await db
    .from("customer_flags")
    .select("customer_id")
    .eq("escalated_to_human", true)
    .lt("last_human_activity_at", cutoff)
    .not("last_human_activity_at", "is", null);

  if (selectError) {
    console.error("[auto-resume-bot]", selectError.message);
    return NextResponse.json({ ok: false, error: selectError.message }, { status: 500 });
  }

  if (!candidates?.length) {
    return NextResponse.json({ ok: true, resumed: 0 });
  }

  await Promise.all(
    candidates.map(({ customer_id }) => tryLearnCustomerContext(customer_id, db)),
  );

  const ids = candidates.map((c) => c.customer_id);
  const { error: updateError } = await db
    .from("customer_flags")
    .update({ escalated_to_human: false, escalation_reason: null, last_human_activity_at: null })
    .in("customer_id", ids);

  if (updateError) {
    console.error("[auto-resume-bot] update failed:", updateError.message);
    return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
  }

  console.log(`[auto-resume-bot] learned context and resumed bot for ${ids.length} customer(s)`);
  return NextResponse.json({ ok: true, resumed: ids.length });
}

export const dynamic = "force-dynamic";
