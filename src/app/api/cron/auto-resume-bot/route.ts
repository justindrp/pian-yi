import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { tryLearnCustomerContext } from "@/lib/claude/learn-context";
import { takeoverCutoff } from "@/lib/customers/takeover";
import { replayLatestCustomerMessage } from "@/lib/inbox/replay-latest";

export async function GET(req: NextRequest): Promise<Response> {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const cutoff = takeoverCutoff();

  // Capped per run because each candidate costs up to two Claude calls —
  // learning the context the admin handled, then generating the reply the
  // customer is still owed. Back when it was one call, a 30-row backlog took
  // over two minutes and Railway's proxy hung up mid-run — the work happened to
  // finish, but a longer one could be killed partway. The proxy is out of the
  // path now that the schedule runs in-process, but the cost is not, so the cap
  // stays. Leftovers are picked up on the next tick, and
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

        // Handing the thread back is not the same as answering it. A customer
        // who wrote during the takeover — often seconds after the admin's last
        // message, which is exactly when the inline resume in the webhook
        // correctly declines to cut in — has been waiting ever since, and
        // clearing a flag sends them nothing. Until now the only thing that
        // replayed that message was the admin inbox in a browser, and only if
        // an admin happened to have that thread selected when the flag
        // flipped. Cindy Angelia's 13.22 message on 2026-08-13 was answered at
        // 21.03, when a human finally opened the thread.
        //
        // The guards live in replayLatestCustomerMessage: it only speaks when
        // the newest message is still the customer's, so a thread the admin
        // already answered stays quiet. Failure here is logged, not thrown —
        // the resume itself succeeded and must not be rolled back for it.
        const replay = await replayLatestCustomerMessage(customer_id, db).catch(
          (err: Error) => ({ replayed: false, reason: err.message }),
        );
        if (!replay.replayed && replay.reason !== "latest_not_user") {
          console.log(
            `[auto-resume-bot] ${customer_id} resumed, not replayed: ${replay.reason}`,
          );
        }
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
