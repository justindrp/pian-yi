import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sendOutageAlert, warmRecipientCache } from "@/lib/push/send";

// Nobody knew the database was down until Justin opened the dashboard.
//
// On 2026-09-21 this project's PostgREST container wedged — accepting
// connections and answering zero bytes — for about ninety minutes. Postgres
// itself was fine the whole time: auth and storage, which read it over their
// own connections, answered in under a third of a second. Every cron firing in
// that window failed, the chat-review cycle sent nothing, and the first signal
// any human got was a spinner that never stopped.
//
// So: probe the one service that failed, on its own, every minute.
//
// Two rules make this worth having rather than worth muting:
//
//  1. It alerts on the *transition*, never on the state. A push a minute for
//     ninety minutes trains everyone to swipe it away, and the next outage goes
//     unread on purpose. Down once, recovered once.
//  2. It needs `FAILURES_BEFORE_ALERT` consecutive failures before it believes
//     anything. A single timeout is a blip; two in a row is an outage.
//
// It also deliberately does NOT use the Supabase client. That client is
// generic — retries, auth refresh, its own error shapes — and this is a
// liveness probe, where the only interesting answers are "bytes came back
// quickly" and "they did not". A bare fetch with a hard deadline says exactly
// that.

/** Short: this is liveness, not a query budget. Past this it is down. */
const PROBE_TIMEOUT_MS = 8_000;

/** One failure is a blip. Two in a row, a minute apart, is an outage. */
const FAILURES_BEFORE_ALERT = 2;

// Module state, which means it resets on deploy. That is correct: a fresh
// process has no idea what happened before it, and the first probe re-
// establishes the truth within a minute.
let consecutiveFailures = 0;
let alerted = false;
let downSince: number | null = null;

type Probe = { ok: boolean; ms: number; detail: string };

async function probeRest(): Promise<Probe> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, ms: 0, detail: "env missing" };

  const startedAt = Date.now();
  try {
    const res = await fetch(`${url}/rest/v1/settings?select=key&limit=1`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    // Read the body: the 2026-09-21 failure mode was a socket that connected,
    // answered headers and then delivered nothing, so a status code alone
    // would have called it healthy.
    const body = await res.text();
    const ms = Date.now() - startedAt;
    if (!res.ok) return { ok: false, ms, detail: `HTTP ${res.status}` };
    if (body.length === 0) return { ok: false, ms, detail: "empty body" };
    return { ok: true, ms, detail: `HTTP ${res.status}` };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const detail = err instanceof Error ? err.name : "fetch failed";
    return { ok: false, ms, detail };
  }
}

function minutesSince(ts: number): number {
  return Math.round((Date.now() - ts) / 60_000);
}

export async function GET(req: NextRequest): Promise<Response> {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const probe = await probeRest();

  if (probe.ok) {
    const recovered = alerted;
    const outageMinutes = downSince === null ? 0 : minutesSince(downSince);
    consecutiveFailures = 0;
    alerted = false;
    downSince = null;

    // While it still can: an outage alert can only reach devices we looked up
    // before the lookup stopped working.
    await warmRecipientCache();

    if (recovered) {
      console.log(
        `[db-health] recovered after ~${outageMinutes} min (${probe.ms}ms)`,
      );
      await sendOutageAlert(
        "Database is back",
        `Supabase is answering again after about ${outageMinutes} menit. Check that today's crons caught up.`,
      );
    }
    return NextResponse.json({
      ok: true,
      data: { healthy: true, ms: probe.ms, recovered },
    });
  }

  consecutiveFailures += 1;
  downSince ??= Date.now();
  console.error(
    `[db-health] probe failed (${consecutiveFailures}×): ${probe.detail} after ${probe.ms}ms`,
  );

  let notified = 0;
  if (!alerted && consecutiveFailures >= FAILURES_BEFORE_ALERT) {
    alerted = true;
    notified = await sendOutageAlert(
      "Database unreachable",
      `Supabase has not answered for ${consecutiveFailures} checks (${probe.detail}). Run pnpm db-doctor.`,
    );
    console.error(`[db-health] outage alert sent to ${notified} device(s)`);
  }

  return NextResponse.json({
    ok: true,
    data: {
      healthy: false,
      detail: probe.detail,
      consecutiveFailures,
      alerted,
      notified,
    },
  });
}
