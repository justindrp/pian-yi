import { type NextRequest, NextResponse } from "next/server";
import { replayLatestCustomerMessage } from "@/lib/inbox/replay-latest";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoPhone } from "@/lib/whatsapp/demo";
import {
  parseMessage,
  type WhatsAppWebhookPayload,
} from "@/lib/whatsapp/types";

// Answers customers whose message the webhook accepted and then dropped on the
// floor.
//
// The webhook returns 200 to Meta and finishes the work in a detached promise,
// which then sleeps BURST_WINDOW_MS to coalesce a typing burst. If the process
// dies inside that window — a Railway deploy, a restart — the promise dies with
// it. Meta already has its 200, so it never retries; the `processed_messages`
// row was claimed before the sleep, so the message can never be reprocessed;
// and nothing throws, so `webhook_events.error` stays null. The message is
// simply gone, with the customer left staring at a read receipt.
//
// The sleep moved earlier in processWebhookAsync on 2026-08-29, so a death
// inside it now also skips the welcome sequence for a first-time customer.
// Replaying the saved message answers them but does not send the menu, price
// list and T&C; `customer_state.menu_shown` is still false in that case, so the
// next message they send sends it.
//
// It is not theoretical: on 2026-08-22 a lead asked "Atau ada tambahan ongkir."
// six seconds after "Lippo karawaci Tangerang Tercover free ongkir?". The first
// was correctly suppressed as superseded; the second died mid-sleep, and the
// thread sat silent until a human noticed. Five older events were in the same
// state, going back to 2026-08-18.
//
// The fix is deliberately not "reprocess the webhook payload" — that path
// re-saves the inbound message, re-upserts the customer and can re-send the
// welcome. The inbound row is already in `conversations`; what is missing is
// only the reply. So this replays the saved message, exactly like the inbox
// button and auto-resume-bot do, and holds itself to the same guards.
export async function GET(req: NextRequest): Promise<Response> {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();

  // Well past the 15s burst window plus a model call, so a message still being
  // worked on is never yanked out from under the run that owns it.
  const MIN_AGE_MS = 5 * 60 * 1000;
  // Past this, answering is worse than silence: the customer has moved on and a
  // reply to an hour-old question reads as a bot waking up. Those are stamped
  // with a reason instead, which both takes them out of the queue and leaves
  // them visible.
  const MAX_AGE_MS = 45 * 60 * 1000;
  const BATCH_SIZE = 10;

  const now = Date.now();
  const { data: stuck, error: selectError } = await db
    .from("webhook_events")
    .select("id, event_key, received_at, payload")
    .is("processed_at", null)
    .is("error", null)
    .lt("received_at", new Date(now - MIN_AGE_MS).toISOString())
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (selectError) {
    console.error("[webhook-recovery]", selectError.message);
    return NextResponse.json(
      { ok: false, error: selectError.message },
      { status: 500 },
    );
  }

  const results: Record<string, number> = {};
  const tally = (reason: string) => {
    results[reason] = (results[reason] ?? 0) + 1;
  };

  // Recording the outcome in `error` is what stops a permanently unanswerable
  // event being re-examined every five minutes forever. `processed_at` is left
  // alone unless a reply actually went out, so the two columns keep meaning
  // "answered" and "why not".
  const stamp = async (id: string, reason: string, replied: boolean) => {
    await db
      .from("webhook_events")
      .update(
        replied
          ? { processed_at: new Date().toISOString(), error: null }
          : { error: `recovery: ${reason}` },
      )
      .eq("id", id);
    tally(reason);
  };

  for (const event of stuck ?? []) {
    const message = parseMessage(
      event.payload as unknown as WhatsAppWebhookPayload,
    );
    if (!message) {
      await stamp(event.id, "not_an_inbound_message", false);
      continue;
    }
    if (isDemoPhone(message.from)) {
      await stamp(event.id, "demo_phone", false);
      continue;
    }
    if (now - new Date(event.received_at).getTime() > MAX_AGE_MS) {
      await stamp(event.id, "too_old_to_answer", false);
      continue;
    }

    const { data: customer } = await db
      .from("customers")
      .select("id")
      .eq("phone_number", message.from)
      .maybeSingle();
    if (!customer) {
      await stamp(event.id, "customer_not_found", false);
      continue;
    }

    // The inbound row is the thing being answered. If the process died before
    // it landed, there is no text to reply to and guessing from the payload
    // would answer a message the thread does not contain.
    const { data: saved } = await db
      .from("conversations")
      .select("id")
      .eq("message_id", message.messageId)
      .eq("customer_id", customer.id)
      .maybeSingle();
    if (!saved) {
      await stamp(event.id, "inbound_never_saved", false);
      continue;
    }

    // An admin holding the thread outranks this. replayLatestCustomerMessage
    // checks blacklisting but not escalation — auto-resume-bot clears the flag
    // before it calls in — so the check belongs here, or the bot would talk
    // over a human mid-conversation.
    const { data: flags } = await db
      .from("customer_flags")
      .select("escalated_to_human")
      .eq("customer_id", customer.id)
      .maybeSingle();
    if (flags?.escalated_to_human) {
      await stamp(event.id, "escalated_to_human", false);
      continue;
    }

    try {
      const result = await replayLatestCustomerMessage(customer.id, db);
      await stamp(
        event.id,
        result.replayed ? "replied" : (result.reason ?? "not_replayed"),
        result.replayed,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        "[webhook-recovery] replay failed:",
        event.event_key,
        reason,
      );
      await stamp(event.id, `replay_failed: ${reason}`, false);
    }
  }

  const scanned = stuck?.length ?? 0;
  if (scanned > 0) {
    console.log(
      `[webhook-recovery] scanned ${scanned} — ${JSON.stringify(results)}`,
    );
  }
  return NextResponse.json({ ok: true, data: { scanned, results } });
}

export const dynamic = "force-dynamic";
