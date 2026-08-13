import { Cron } from "croner";
import type { NextRequest } from "next/server";

// Schedules live here, in the app, instead of in ten Railway "cron" services.
//
// Each of those was a container whose only job was to run one curl command
// against a route in this app. Every one of them was broken from the day it was
// created: the container started, ran bare `curl` with no arguments, printed
// curl's usage text and exited. Nothing ever reached the app, so quota was
// never deducted and no reminder was ever sent — silently, for months, because
// nobody reads the logs of a container that is supposed to be boring.
//
// The app already runs 24/7 on Railway, so it can hold its own clock. No
// container to boot, no secret in a start command, no network hop, and the
// failures land in the app's own logs next to everything else.
//
// Times are Asia/Jakarta (WIB), not UTC — the schedules read as the wall-clock
// times the business actually thinks in.
const TZ = "Asia/Jakarta";

type Job = {
  name: string;
  schedule: string;
  /** Wall-clock intent, for the log line and for humans reading this table. */
  when: string;
  run: (req: NextRequest) => Promise<Response>;
  method: "GET" | "POST";
  path: string;
  /**
   * Run this job at boot if its scheduled time passed while the app was down.
   * Only worth setting on the daily jobs: an hourly job that misses a firing
   * picks the same rows up an hour later, because every one of them selects on
   * a flag it stamps itself. A daily job waits 24 hours instead.
   */
  catchUp?: boolean;
};

// The cron routes authenticate on a shared secret. Calling them in-process
// still goes through that check rather than around it, so the routes keep one
// code path whether they are triggered from here or by hand with curl.
function authedRequest(path: string, method: "GET" | "POST"): NextRequest {
  const secret = process.env.CRON_SECRET ?? "";
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      "x-cron-secret": secret,
      authorization: `Bearer ${secret}`,
    },
  }) as unknown as NextRequest;
}

const JOBS: Job[] = [
  {
    name: "auto-resume-bot",
    schedule: "*/15 * * * *",
    when: "every 15 min",
    method: "GET",
    path: "/api/cron/auto-resume-bot",
    run: async (req) =>
      (await import("@/app/api/cron/auto-resume-bot/route")).GET(req),
  },
  {
    name: "abandoned-recovery",
    schedule: "0 * * * *",
    when: "hourly",
    method: "GET",
    path: "/api/cron/abandoned-recovery",
    run: async (req) =>
      (await import("@/app/api/cron/abandoned-recovery/route")).GET(req),
  },
  {
    name: "cancel-unpaid",
    schedule: "0 * * * *",
    when: "hourly",
    method: "POST",
    path: "/api/cron/cancel-unpaid",
    run: async (req) =>
      (await import("@/app/api/cron/cancel-unpaid/route")).POST(req),
  },
  {
    name: "renewal-reminders",
    schedule: "0 * * * *",
    when: "hourly",
    method: "GET",
    path: "/api/cron/renewal-reminders",
    run: async (req) =>
      (await import("@/app/api/cron/renewal-reminders/route")).GET(req),
  },
  {
    name: "send-reminders",
    schedule: "0 */2 * * *",
    when: "every 2 hours",
    method: "POST",
    path: "/api/cron/send-reminders",
    run: async (req) =>
      (await import("@/app/api/cron/send-reminders/route")).POST(req),
  },
  {
    name: "refresh-wa-window",
    catchUp: true,
    schedule: "0 8,20 * * *",
    when: "08:00 and 20:00 WIB",
    method: "GET",
    path: "/api/cron/refresh-wa-window",
    run: async (req) =>
      (await import("@/app/api/cron/refresh-wa-window/route")).GET(req),
  },
  {
    name: "daily-summary",
    catchUp: true,
    schedule: "0 9 * * *",
    when: "09:00 WIB",
    method: "POST",
    path: "/api/cron/daily-summary",
    run: async (req) =>
      (await import("@/app/api/cron/daily-summary/route")).POST(req),
  },
  {
    name: "lapsed-customers",
    catchUp: true,
    schedule: "0 10 * * *",
    when: "10:00 WIB",
    method: "GET",
    path: "/api/cron/lapsed-customers",
    run: async (req) =>
      (await import("@/app/api/cron/lapsed-customers/route")).GET(req),
  },
  {
    name: "post-delivery-followup",
    catchUp: true,
    schedule: "0 15 * * *",
    when: "15:00 WIB",
    method: "GET",
    path: "/api/cron/post-delivery-followup",
    run: async (req) =>
      (await import("@/app/api/cron/post-delivery-followup/route")).GET(req),
  },
  {
    name: "deduct-daily-quota",
    catchUp: true,
    schedule: "0 21 * * *",
    when: "21:00 WIB",
    method: "POST",
    path: "/api/cron/deduct-daily-quota",
    run: async (req) =>
      (await import("@/app/api/cron/deduct-daily-quota/route")).POST(req),
  },
];

// One shared body for a scheduled firing and a catch-up firing, so a job that
// runs late runs exactly as it would have on time.
async function runJob(job: Job, trigger: "scheduled" | "catch-up"): Promise<void> {
  const startedAt = Date.now();
  const label = trigger === "catch-up" ? `${job.name} (catch-up)` : job.name;
  try {
    const res = await job.run(authedRequest(job.path, job.method));
    const body = await res.text();
    const ms = Date.now() - startedAt;
    if (res.ok) {
      console.log(`[scheduler] ${label} ok in ${ms}ms — ${body}`);
      await recordRun(job.name);
    } else {
      console.error(`[scheduler] ${label} HTTP ${res.status} in ${ms}ms — ${body}`);
    }
  } catch (err) {
    console.error(
      `[scheduler] ${label} threw after ${Date.now() - startedAt}ms:`,
      err,
    );
  }
}

// Only a successful run is recorded. A failed one leaves the old timestamp in
// place, so the next boot still sees the occurrence as missed and retries it.
async function recordRun(jobName: string): Promise<void> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { error } = await createAdminClient()
      .from("cron_runs")
      .upsert(
        { job_name: jobName, last_run_at: new Date().toISOString() },
        { onConflict: "job_name" },
      );
    if (error) throw new Error(error.message);
  } catch (err) {
    // Losing the record costs at most one redundant catch-up run, which every
    // catchUp job tolerates. It must never take the job itself down.
    console.error(`[scheduler] could not record run of ${jobName}:`, err);
  }
}

// The most recent time this schedule was due, at or before `now`. Croner has no
// "previous occurrence" call, so walk forward from a day and a bit ago and keep
// the last occurrence that has already passed — enough range for a twice-daily
// pattern, which is the densest any catchUp job uses.
export function lastDueAt(schedule: string, now: Date): Date | null {
  const from = new Date(now.getTime() - 26 * 3600 * 1000);
  const runs = new Cron(schedule, { timezone: TZ }).nextRuns(60, from) ?? [];
  const past = runs.filter((r) => r <= now);
  return past.length > 0 ? past[past.length - 1] : null;
}

export function jakartaDay(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: TZ });
}

// Runs any catchUp job whose scheduled time passed while the app was down.
//
// The same-day rule is not caution, it is correctness: deduct-daily-quota
// deducts for "tomorrow" and daily-summary reports on "yesterday", both
// relative to when they run, not to when they were due. Firing 21:00's quota
// job at 08:00 the next morning would deduct the wrong day's deliveries and
// leave the right day untouched. Inside the same Jakarta day those phrases
// still mean what the schedule intended, so that is as late as a catch-up may
// run; a longer outage is logged and skipped rather than acted on wrongly.
async function catchUpMissedJobs(): Promise<void> {
  const jobs = JOBS.filter((j) => j.catchUp);
  if (jobs.length === 0) return;

  let lastRuns: Record<string, string> = {};
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient()
      .from("cron_runs")
      .select("job_name, last_run_at");
    if (error) throw new Error(error.message);
    lastRuns = Object.fromEntries(
      (data ?? []).map((r) => [r.job_name, r.last_run_at]),
    );
  } catch (err) {
    // Without the table there is no way to tell "missed it" from "already ran",
    // and guessing would mean re-sending. Skip the sweep; the normal schedule
    // is unaffected.
    console.error("[scheduler] catch-up skipped, could not read cron_runs:", err);
    return;
  }

  const now = new Date();
  for (const job of jobs) {
    const due = lastDueAt(job.schedule, now);
    if (!due) continue;

    const lastRun = lastRuns[job.name];
    // A job with no record at all is being seen for the first time — a fresh
    // database, or a job added after this table existed. Seeding it without
    // running means the first deploy of a new job cannot fire it at an
    // arbitrary hour; it waits for its real schedule.
    if (!lastRun) {
      await recordRun(job.name);
      console.log(`[scheduler] ${job.name} first seen, seeded without running`);
      continue;
    }

    if (new Date(lastRun) >= due) continue;

    if (jakartaDay(due) !== jakartaDay(now)) {
      console.log(
        `[scheduler] ${job.name} missed ${due.toISOString()} but that was a previous day — skipping`,
      );
      continue;
    }

    console.log(
      `[scheduler] ${job.name} missed its ${job.when} run, catching up now`,
    );
    await runJob(job, "catch-up");
  }
}

let started = false;

export function startScheduler(): void {
  if (started) return;

  // Off unless explicitly enabled. Local dev points at the production database,
  // so a laptop running `next dev` with this on would send real customers real
  // WhatsApp messages. Railway sets CRON_IN_APP=true; nothing else should.
  if (process.env.CRON_IN_APP !== "true") {
    console.log("[scheduler] disabled (CRON_IN_APP is not \"true\")");
    return;
  }

  started = true;

  for (const job of JOBS) {
    new Cron(
      job.schedule,
      // protect: skip a firing if the previous one is still running, so a slow
      // job can never stack copies of itself.
      { name: job.name, timezone: TZ, protect: true },
      () => runJob(job, "scheduled"),
    );
  }

  console.log(
    `[scheduler] started ${JOBS.length} jobs (${TZ}): ${JOBS.map(
      (j) => `${j.name} ${j.when}`,
    ).join(", ")}`,
  );

  // Deliberately not awaited: boot must not wait on Claude calls or WhatsApp
  // sends. Failures inside are already logged per job.
  void catchUpMissedJobs();
}
