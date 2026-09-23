-- Who works for us, for the bot to confirm when a customer asks whether
-- someone who contacted them "atas nama" us really is ours.
--
-- On 2026-09-23 a kitchen owner approached by Jennifer about becoming a dapur
-- partner asked us to confirm her, and the bot — with nothing telling it she
-- was staff — twice told them to hold off on her.
--
-- Empty on purpose, like task_reminder_phones: a line may carry a personal
-- WhatsApp number, and that belongs in the database, not in the repository.
-- Filled in at /settings.
insert into public.settings (key, value, description)
values (
  'team_roster',
  '',
  'One person per line: "Nama — peran", plus the WhatsApp number they contact people from. The bot confirms these people to customers who ask; anyone not listed is neither confirmed nor denied and goes to an admin.'
)
on conflict (key) do nothing;
