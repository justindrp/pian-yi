import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";

// Taking a thread over is owner-only. Handing it back to the bot is not.
//
// Takeover silences the bot for that customer, and everything the bot would
// have done — scheduling the package's delivery rows above all — becomes the
// admin's job to remember. On 2026-08-18 Jordy's 5-porsi package was hand-run
// that way and only two of its five days ever got written; he found out by
// getting no lunch, and asked for a refund. The bot generates those rows from
// the order without being reminded to.
//
// The `escalated: false` direction stays open to everyone on purpose: it
// returns the thread to the bot, which is the safe direction, and the inbox
// draft flow calls it to clear a stale takeover before replying.
export async function POST(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { customer_id: string; escalated: boolean };
  const { customer_id, escalated } = body;

  if (!customer_id || typeof escalated !== "boolean") {
    return NextResponse.json({ ok: false, error: "Missing customer_id or escalated" }, { status: 400 });
  }

  if (escalated && !isOwner(session.role)) {
    return NextResponse.json(
      { ok: false, error: "Only owners can take over a conversation" },
      { status: 403 },
    );
  }

  const db = createAdminClient();
  const { error } = await db
    .from("customer_flags")
    .upsert({
      customer_id,
      escalated_to_human: escalated,
      escalation_reason: escalated ? "Manual takeover" : null,
      last_human_activity_at: escalated ? new Date().toISOString() : null,
      pending_bot_response: false,
      pending_bot_question: null,
    });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
