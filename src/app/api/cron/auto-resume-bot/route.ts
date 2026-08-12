import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { tryLearnCustomerContext } from "@/lib/claude/learn-context";
import { takeoverCutoff } from "@/lib/customers/takeover";

export async function GET(req: NextRequest): Promise<Response> {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const cutoff = takeoverCutoff();

  // Capped per run because each candidate costs one Claude call (learning the
  // context the admin handled). A 30-row backlog took over two minutes and
  // Railway's proxy hung up mid-run — the work happened to finish, but a longer
  // one could be killed partway. Leftovers are picked up on the next tick, and
  // by the inline resume in the webhook the moment the customer writes.
  const BATCH_SIZE = 10;

  const { data: candidates, error: selectError } = await db
    .from("customer_flags")
    .select("customer_id")
    .eq("escalated_to_human", true)
    .lt("last_human_activity_at", cutoff)
    .not("last_human_activity_at", "is", null)
    .order("last_human_activity_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (selectError) {
    console.error("[auto-resume-bot]", selectError.message);
    return NextResponse.json({ ok: false, error: selectError.message }, { status: 500 });
  }

  if (!candidates?.length) {
    return NextResponse.json({ ok: true, resumed: 0 });
  }

  // Each customer's flags are cleared right after their own context lands, so a
  // run cut short leaves every customer either fully resumed or fully untouched
  // — never "context learned, still escalated", which would pay for the Claude
  // call and hand nothing back.
  const results = await Promise.all(
    candidates.map(async ({ customer_id }) => {
      try {
        await tryLearnCustomerContext(customer_id, db);
        const { error } = await db
          .from("customer_flags")
          .update({
            escalated_to_human: false,
            escalation_reason: null,
            last_human_activity_at: null,
          })
          .eq("customer_id", customer_id);
        if (error) throw new Error(error.message);
        return true;
      } catch (err) {
        console.error(
          `[auto-resume-bot] ${customer_id} failed:`,
          (err as Error).message,
        );
        return false;
      }
    }),
  );

  const resumed = results.filter(Boolean).length;
  console.log(
    `[auto-resume-bot] learned context and resumed bot for ${resumed} of ${candidates.length} customer(s)`,
  );
  return NextResponse.json({ ok: true, resumed, attempted: candidates.length });
}

export const dynamic = "force-dynamic";
