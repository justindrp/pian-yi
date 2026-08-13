-- Records when each scheduled job last completed successfully.
--
-- The schedule runs in-process (src/lib/cron/scheduler.ts), so it has no memory
-- across restarts: a job whose firing time passed while the app was redeploying
-- was simply skipped. The hourly jobs shrug that off — each one selects on a
-- flag it then stamps (abandoned_recovery_sent_at, reminder_sent_at,
-- quota_deducted), so the rows it missed still match an hour later. The daily
-- jobs do not: a 21:00 deploy costs deduct-daily-quota a full day.
--
-- This table is what lets the scheduler tell "already ran today" from "missed
-- it", which is the whole basis of the boot-time catch-up. It is deliberately
-- one row per job rather than a run history — nothing needs the log, and a
-- growing table would need pruning nobody would remember to write.

CREATE TABLE cron_runs (
  job_name text PRIMARY KEY,
  last_run_at timestamptz NOT NULL
);

-- Server-only: written by the scheduler through the service-role client, never
-- read or written by a browser session.
ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;
