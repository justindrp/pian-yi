import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { getSetting } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";

// Clears questions parked with an admin that nobody answered and nobody is
// waiting on any more.
//
// `pending_bot_response` is set by `ask_admin_for_help` and by the webhook's
// claimed-escalation guard, and until now only a human ever unset it — a
// takeover, a manual send, or the bot-reply route. Everything else left it
// standing forever. On 2026-09-09 nineteen of the twenty-five threads in the
// Unanswered tab were flags whose question had long since stopped mattering:
// Clariza's had run since 10 July over a delivery photo she confirmed
// receiving in the next message, Valen's since 3 July with no question text at
// all, Kurniadi's question was the single word "Ok". The tab read three times
// the real backlog, so nobody read it, so the six real ones sat for days.
//
// The clock is not "when we parked it" but "when the customer last wrote",
// refreshed in the webhook on every inbound message while the flag stands.
// That is what separates a thread that has moved on from one that is still
// waiting: the Karawaci lead had been owed a no-MSG answer for five days and
// chased on the fifth, and a flat age cutoff would have quietly dropped her on
// day two. A customer who keeps asking never ages out.
//
// This job does not message anyone. Clearing the flag lets the model answer
// the customer normally again — the prompt stops telling it a question is with
// an admin — which is the right outcome for a question no admin was ever going
// to answer.
export async function GET(req: NextRequest): Promise<Response> {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();
  const hoursRaw = await getSetting("pending_question_expiry_hours");
  const hours = Number.parseInt(hoursRaw ?? "48", 10) || 48;
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // `pending_bot_question_at` is null only on a flag set before migration 104
  // that the backfill could not date — no conversation rows and no
  // `created_at`. Left alone rather than swept: a row we cannot date is a row
  // we cannot say has gone quiet.
  const { data: stale, error } = await db
    .from("customer_flags")
    .select("customer_id, pending_bot_question, pending_bot_question_at")
    .eq("pending_bot_response", true)
    .not("pending_bot_question_at", "is", null)
    .lt("pending_bot_question_at", cutoff);
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }
  if (!stale || stale.length === 0) {
    return NextResponse.json({ ok: true, expired: 0 });
  }

  const ids = stale.map((f) => f.customer_id);
  const { error: clearErr } = await db
    .from("customer_flags")
    .update({
      pending_bot_response: false,
      pending_bot_question: null,
      pending_bot_question_at: null,
    })
    .in("customer_id", ids);
  if (clearErr) {
    return NextResponse.json(
      { ok: false, error: clearErr.message },
      { status: 500 },
    );
  }

  // One row each, so a question that turns out to have mattered can still be
  // read back. The flag is the only place the text was ever kept, and clearing
  // it is the only thing that destroys it.
  for (const f of stale) {
    await logEdit({
      db,
      actor: "system:expire-pending-questions",
      entityType: "customer_flags",
      entityId: f.customer_id,
      action: "expire_pending_question",
      changes: {
        pending_bot_question: f.pending_bot_question,
        pending_bot_question_at: f.pending_bot_question_at,
        quiet_for_hours: hours,
      },
    });
  }

  console.log(
    `[expire-pending-questions] cleared ${stale.length} question(s) quiet for over ${hours}h`,
  );
  return NextResponse.json({ ok: true, expired: stale.length });
}
