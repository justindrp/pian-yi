-- Three things, all in service of one question the tasks page could not answer:
-- what am I working on right now?
--
-- 232 open tasks is far past what anyone holds in their head, so the page has
-- to be the memory rather than a reminder of it. `in_progress` was the field
-- for that and it carried 1 row out of 334, because setting it meant opening
-- the drawer, changing a dropdown and saving — three deliberate acts of
-- bookkeeping for a fact that is only true for a few hours.
--
-- 1. `todo` and `open` were the same state under two spellings. 32 rows sat on
--    `todo`, which has no filter chip on /tasks, so they were invisible under
--    every filter except "All".
--
-- 2. A check constraint, which migration 072 explicitly declined: "Deliberately
--    not an enum: the lifecycle here is a convention between three people, not
--    a state machine anything computes on." That reasoning held while the
--    writers were people using a form. They are not — `POST /api/tasks` has
--    validated status against an allowlist since it was written, and every one
--    of the 32 strays came from a throwaway script writing through the admin
--    client, which goes around the route. A convention nothing enforces drifted
--    in nine days.
--
-- 3. A work-in-progress limit, in settings rather than in code because it is a
--    fact about one person's capacity and may change.
update public.tasks set status = 'open' where status = 'todo';

alter table public.tasks
  drop constraint if exists tasks_status_check;
alter table public.tasks
  add constraint tasks_status_check
  check (status in ('open', 'in_progress', 'blocked', 'done'));

comment on column public.tasks.status is
  'open | in_progress | blocked | done, enforced by tasks_status_check since migration 107. `in_progress` is capped by settings.task_wip_limit.';

-- 3, because that is how many live threads Justin can actually hold. It is not
-- the usual kanban number: those are set from headcount (one per person, or
-- people x 1.5), so the customary 5 describes a team of four and says nothing
-- about one person. A limit above the real capacity does not restrain anything,
-- and the strip fills with work that stopped being in progress weeks ago.
insert into public.settings (key, value, description)
values (
  'task_wip_limit',
  '3',
  'How many tasks may be in progress at once. The /tasks page refuses to start a fourth.'
)
on conflict (key) do nothing;
