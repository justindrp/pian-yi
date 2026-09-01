-- A takeover could not outlive the admin's silence.
--
-- Both resume paths — the inline check in the WhatsApp webhook and the
-- auto-resume cron — asked one question: has it been 30 minutes since
-- last_human_activity_at? That is the right question for the thread an admin
-- forgot to hand back, and the wrong one for the thread an admin is
-- deliberately holding while something happens off WhatsApp. On 2026-09-01
-- Carolin's refund negotiation was handed back mid-negotiation and the bot
-- answered her three times, promising things it has no tool to do.
--
-- hold_until is the deliberate hold: while it is in the future neither path
-- resumes, no matter how quiet the admin has been. Null means the old rule,
-- unchanged, which is what every existing row gets. It always carries a real
-- expiry — a hold with no end is how 31 threads sat escalated with nobody
-- watching in August 2026, which is the bug auto-resume was written for.
alter table customer_flags add column if not exists hold_until timestamptz;

comment on column customer_flags.hold_until is
  'While in the future, neither the webhook''s inline resume nor the auto-resume cron hands this thread back to the bot, regardless of last_human_activity_at. Null = the ordinary 30-minute inactivity rule. Set on takeover and by scripts; always finite.';

-- The sweep reads it on every run, alongside the escalated/last-activity pair
-- it already filters on.
create index if not exists idx_customer_flags_hold_until
  on customer_flags (hold_until)
  where hold_until is not null;
