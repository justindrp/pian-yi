/**
 * A `fetch` that gives up, for every Supabase client in the app.
 *
 * On 2026-09-21 this project's PostgREST container wedged: it accepted
 * connections and then returned nothing at all. Postgres itself was fine the
 * whole time — auth read `auth.users` in 0.32s and storage read its buckets in
 * 0.22s while `/rest/v1/` returned zero bytes on every attempt. Only the one
 * service the whole app talks through was dead.
 *
 * What made that a 90-minute outage rather than a 90-minute error was here: no
 * client in this app set a timeout, so every call waited on Supabase's own
 * gateway to give up at ~125s. That is where `HTTP 500 in 125028ms` in the
 * scheduler logs came from — it was never our number. `/inbox` spun forever,
 * server components hung until they threw, and each cron burned two minutes
 * discovering what one second would have told it.
 *
 * A timeout does not keep the database up. It decides whether a database that
 * is down looks like a broken page or a blank one, and how fast the app can
 * say so.
 */

/** Overridable because a slow bulk cron is a different animal from a page. */
const DEFAULT_TIMEOUT_MS = Number(
  process.env.SUPABASE_REQUEST_TIMEOUT_MS ?? 15_000,
);

/** Thrown instead of a bare `AbortError`, so callers can tell a timeout apart
 * from a user-cancelled request and say something useful about it. */
export class SupabaseTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(
      `Supabase request timed out after ${timeoutMs}ms: ${url}. The database ` +
        `did not respond — this is an outage, not a slow query.`,
    );
    this.name = "SupabaseTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Strips the project host and query string: enough to identify the call in a
 * log line, without putting filter values (phone numbers, ids) in it. */
function describe(input: RequestInfo | URL): string {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  try {
    return new URL(raw).pathname;
  } catch {
    return raw;
  }
}

export function createTimeoutFetch(
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): typeof fetch {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    // A caller's own signal still has to work — supabase-js passes one for
    // auth refresh — so honour whichever fires first.
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;

    try {
      return await fetch(input, { ...init, signal });
    } catch (err) {
      if (timeout.aborted) {
        const error = new SupabaseTimeoutError(describe(input), timeoutMs);
        console.error(`[supabase] ${error.message}`);
        throw error;
      }
      throw err;
    }
  };
}
