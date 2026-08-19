/**
 * Demo customers exist so real conversations can be replayed against the live
 * pipeline (`scripts/replay-orders.ts`) without a single message reaching a
 * real phone. Their `phone_number` is deliberately not a number — no WhatsApp
 * account can ever have this shape — so the guard cannot be tripped by a real
 * customer's number, however it is formatted.
 *
 * The stub lives in the WhatsApp client rather than in the replay script
 * because it has to hold for *every* path that might touch a demo customer:
 * the crons, the assistant, the inbox, a stray script. A send that silently
 * does nothing is dangerous everywhere else, which is why the trigger is the
 * recipient's identity and never an env var.
 */
export const DEMO_PHONE_PREFIX = "DEMO_";

export function isDemoPhone(phone: string | null | undefined): boolean {
  if (typeof phone !== "string") return false;
  // parseMessage prefixes a "+" onto anything that lacks one, so the same
  // customer arrives as both "DEMO_x" and "+DEMO_x" depending on the path.
  const bare = phone.startsWith("+") ? phone.slice(1) : phone;
  return bare.startsWith(DEMO_PHONE_PREFIX);
}

/** A stand-in wamid, shaped like Meta's so callers that store it are exercised. */
export function demoMessageId(): string {
  return `wamid.DEMO${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
}

/**
 * What a demo customer is called in the inbox. A replayed conversation carries
 * the real customer's name, and writing it to the demo row put a second "Nadya"
 * in the thread list next to the real one — an admin one tap away from
 * answering a replay instead of a customer. The real name is never stored on a
 * demo row; the phone suffix is enough to tell which case it came from.
 */
export function demoDisplayName(phone: string): string {
  const bare = phone.startsWith("+") ? phone.slice(1) : phone;
  return `[DEMO] ${bare.slice(DEMO_PHONE_PREFIX.length)}`;
}
