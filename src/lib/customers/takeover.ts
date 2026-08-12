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

// A thread with no `last_human_activity_at` is never auto-resumed. Those rows
// pre-date the timestamp being written on takeover, and without a clock there
// is no way to tell "handled 3 minutes ago" from "abandoned in June" — so they
// stay with the human rather than risk the bot cutting into live handling.
export function shouldAutoResume(
  lastHumanActivityAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!lastHumanActivityAt) return false;
  const last = new Date(lastHumanActivityAt).getTime();
  if (Number.isNaN(last)) return false;
  return now - last >= TAKEOVER_INACTIVITY_MINUTES * 60 * 1000;
}
