-- The handsets that get the morning task reminder.
--
-- Empty on purpose: `getSetting` returns "" for a key it cannot find, so the
-- cron no-ops and falls back to push until somebody fills this in at /settings.
-- Shipping it empty rather than with a number in it keeps a personal phone out
-- of the repository and out of the migration history.
--
-- Comma-separated, the same shape as `proof_forwarder_phones`, and it should
-- hold the same numbers: a handset that is not a proof forwarder is treated as
-- a customer by the webhook, so replying to the reminder would open a customer
-- thread and the bot would start selling catering to its own admin.
insert into public.settings (key, value, description)
values (
  'task_reminder_phones',
  '',
  'Comma-separated WhatsApp numbers that receive the 07:00 WIB task reminder. Use the same handsets as proof_forwarder_phones. Empty = push notification only.'
)
on conflict (key) do nothing;
