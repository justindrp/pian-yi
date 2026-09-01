// How long a thread stays with the human before the bot takes it back.
//
// Two paths hand a thread back and both read this, so they can never drift:
// the inline check in the WhatsApp webhook (fires when the customer writes) and
// the auto-resume cron (sweeps threads whose customer never writes again).
//
// 30 minutes, not the 10 the cron route originally assumed: 10 is short enough
// that an admin composing a careful reply could have the bot cut in on the
// customer's follow-up mid-conversation.
export const TAKEOVER_INACTIVITY_MINUTES = 30;

export function takeoverCutoff(now: number = Date.now()): string {
  return new Date(now - TAKEOVER_INACTIVITY_MINUTES * 60 * 1000).toISOString();
}

// The durations a takeover may be held for. Anything longer is a thread nobody
// is really working, and an hour of silence in the inbox is how a customer ends
// up talking to nobody for a day.
export const HOLD_CHOICES_MINUTES = [
  TAKEOVER_INACTIVITY_MINUTES,
  120,
  60 * 24,
] as const;

export function holdUntil(minutes: number, now: number = Date.now()): string {
  return new Date(now + minutes * 60 * 1000).toISOString();
}

export function isHeld(
  holdUntilAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!holdUntilAt) return false;
  const until = new Date(holdUntilAt).getTime();
  if (Number.isNaN(until)) return false;
  return until > now;
}

// A thread with no `last_human_activity_at` is never auto-resumed. Those rows
// pre-date the timestamp being written on takeover, and without a clock there
// is no way to tell "handled 3 minutes ago" from "abandoned in June" — so they
// stay with the human rather than risk the bot cutting into live handling.
//
// `hold_until` outranks the clock in the other direction: while it is in the
// future the thread stays with the human however long they have been quiet.
// Silence is what an admin looks like while they are waiting on something off
// WhatsApp — a transfer, a courier, a decision. Carolin's refund negotiation
// was handed back 30 minutes into exactly that on 2026-09-01, and the bot
// answered her three times about a refund it cannot make.
export function shouldAutoResume(
  flags: {
    last_human_activity_at?: string | null;
    hold_until?: string | null;
  },
  now: number = Date.now(),
): boolean {
  if (isHeld(flags.hold_until, now)) return false;
  const lastHumanActivityAt = flags.last_human_activity_at;
  if (!lastHumanActivityAt) return false;
  const last = new Date(lastHumanActivityAt).getTime();
  if (Number.isNaN(last)) return false;
  return now - last >= TAKEOVER_INACTIVITY_MINUTES * 60 * 1000;
}

// What both resume paths write. `hold_until` is cleared with the rest: a hold
// that outlived its thread would silence the bot for the next conversation.
export const RESUMED_FLAGS = {
  escalated_to_human: false,
  escalation_reason: null,
  last_human_activity_at: null,
  hold_until: null,
} as const;
