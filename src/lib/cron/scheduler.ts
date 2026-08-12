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
    schedule: "0 8,20 * * *",
    when: "08:00 and 20:00 WIB",
    method: "GET",
    path: "/api/cron/refresh-wa-window",
    run: async (req) =>
      (await import("@/app/api/cron/refresh-wa-window/route")).GET(req),
  },
  {
    name: "daily-summary",
    schedule: "0 9 * * *",
    when: "09:00 WIB",
    method: "POST",
    path: "/api/cron/daily-summary",
    run: async (req) =>
      (await import("@/app/api/cron/daily-summary/route")).POST(req),
  },
  {
    name: "lapsed-customers",
    schedule: "0 10 * * *",
    when: "10:00 WIB",
    method: "GET",
    path: "/api/cron/lapsed-customers",
    run: async (req) =>
      (await import("@/app/api/cron/lapsed-customers/route")).GET(req),
  },
  {
    name: "post-delivery-followup",
    schedule: "0 15 * * *",
    when: "15:00 WIB",
    method: "GET",
    path: "/api/cron/post-delivery-followup",
    run: async (req) =>
      (await import("@/app/api/cron/post-delivery-followup/route")).GET(req),
  },
  {
    name: "deduct-daily-quota",
    schedule: "0 21 * * *",
    when: "21:00 WIB",
    method: "POST",
    path: "/api/cron/deduct-daily-quota",
    run: async (req) =>
      (await import("@/app/api/cron/deduct-daily-quota/route")).POST(req),
  },
];

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
      async () => {
        const startedAt = Date.now();
        try {
          const res = await job.run(authedRequest(job.path, job.method));
          const body = await res.text();
          const ms = Date.now() - startedAt;
          if (res.ok) {
            console.log(`[scheduler] ${job.name} ok in ${ms}ms — ${body}`);
          } else {
            console.error(
              `[scheduler] ${job.name} HTTP ${res.status} in ${ms}ms — ${body}`,
            );
          }
        } catch (err) {
          console.error(
            `[scheduler] ${job.name} threw after ${Date.now() - startedAt}ms:`,
            err,
          );
        }
      },
    );
  }

  console.log(
    `[scheduler] started ${JOBS.length} jobs (${TZ}): ${JOBS.map(
      (j) => `${j.name} ${j.when}`,
    ).join(", ")}`,
  );
}
