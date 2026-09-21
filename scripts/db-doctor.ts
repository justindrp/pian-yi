/**
 * Probes the three Supabase services separately and says which half is broken.
 *
 *   pnpm db-doctor
 *
 * Exit codes: 0 all healthy, 1 PostgREST wedged (restart the project),
 * 2 whole project down or restarting, 3 could not read the environment.
 *
 * They fail independently, and only one of them is the app's data path. On
 * 2026-09-21 PostgREST returned zero bytes for ninety minutes while auth and
 * storage answered in under a third of a second each — the database was
 * healthy throughout and a project restart fixed it. Ninety minutes went into
 * reaching that conclusion by hand, via three wrong ones: that Supabase was
 * down, that the project was paused, that the egress quota had cut us off.
 * This script is that reasoning, so nobody has to repeat it.
 *
 * Why these three endpoints and no others: each one reads Postgres through a
 * different service, so agreement between them isolates the fault.
 *   - /rest/v1/   PostgREST — every query the app makes
 *   - /auth/v1/token   GoTrue — reads auth.users. Deliberately bad credentials:
 *     a fast 400 proves the read happened. /auth/v1/health does NOT touch the
 *     database and must never be used as the liveness probe.
 *   - /storage/v1/bucket   Storage — reads its own tables
 */

const TIMEOUT_MS = 12_000;

type Probe = {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
};

async function probe(
  name: string,
  url: string,
  init: RequestInit,
  accept: (status: number) => boolean,
): Promise<Probe> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    return {
      name,
      ok: accept(res.status),
      detail: `HTTP ${res.status}`,
      ms,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      name,
      ok: false,
      detail: timedOut ? `no response in ${TIMEOUT_MS}ms` : String(err),
      ms,
    };
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) {
    console.error(
      "Missing Supabase env. Run via `pnpm db-doctor`, which passes --env-file=.env.local.",
    );
    process.exit(3);
  }

  const results = await Promise.all([
    // A valid key that returns rows. An invalid key would 401 at the edge
    // without ever reaching PostgREST, which is exactly the case we must not
    // mistake for health.
    probe(
      "rest     (PostgREST — the app's data path)",
      `${url}/rest/v1/settings?select=key&limit=1`,
      { headers: { apikey: service, Authorization: `Bearer ${service}` } },
      (s) => s === 200,
    ),
    probe(
      "auth     (GoTrue — reads auth.users)",
      `${url}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: { apikey: anon, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "db-doctor-probe@example.invalid",
          password: "not-a-real-password",
        }),
      },
      // 400 invalid_credentials is the healthy answer: the row was looked up.
      (s) => s === 400 || s === 200,
    ),
    probe(
      "storage  (reads its own tables)",
      `${url}/storage/v1/bucket`,
      { headers: { apikey: service, Authorization: `Bearer ${service}` } },
      (s) => s === 200,
    ),
  ]);

  for (const r of results) {
    console.log(
      `  ${r.ok ? "ok  " : "DOWN"}  ${r.name.padEnd(44)} ${r.detail} (${r.ms}ms)`,
    );
  }
  console.log("");

  const [rest, auth, storage] = results;
  const postgresAlive = auth.ok || storage.ok;

  if (rest.ok) {
    console.log("All healthy — the database is not your problem.");
    console.log("Look at Railway logs next: `railway logs`.");
    process.exit(0);
  }

  if (postgresAlive) {
    console.log("PostgREST is wedged. Postgres itself is HEALTHY —");
    console.log(
      `  ${auth.ok ? "auth" : "storage"} just read from it in ${auth.ok ? auth.ms : storage.ms}ms.`,
    );
    console.log("");
    console.log("  FIX: restart the project.");
    console.log("  Dashboard → Project Settings → General → Restart project.");
    console.log("  Back in ~2 minutes. No data is at risk; Postgres is fine.");
    console.log("");
    console.log(
      "  Close open dashboard tabs first so they do not re-hammer the new pool.",
    );
    console.log(
      "  Customer messages are safe: the webhook 503s rather than 200s, so Meta redelivers.",
    );
    process.exit(1);
  }

  console.log("Everything is down — the project itself, not just the data path.");
  console.log(
    "  If you just restarted, this is expected. Wait ~2 min and run again.",
  );
  console.log("  If you did not, check https://status.supabase.com.");
  process.exit(2);
}

main().catch((err) => {
  console.error("db-doctor failed:", err);
  process.exit(3);
});

// No imports in this file, so without this it is a global script rather than
// a module, and its `main` collides with every other script`s.
export {};
