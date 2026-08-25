-- The work queue, moved out of TASKS.md.
--
-- The backlog lived in a markdown file at the repo root: 251 lines, seven
-- sections, ~30 items, done-ness expressed as ~~strikethrough~~. That worked
-- while the only reader was a person or a session that loads the whole file,
-- and it stopped working the moment anyone wanted to ask "what is open and
-- assigned to Annie" — the answer was only ever available by reading all of it.
--
-- Status, priority, owner and area are columns here instead of prose, and a
-- task can point at the customer or order it is actually about, which is the
-- one thing a general-purpose tracker cannot do: "Cindi — second address
-- missing" resolves to her record rather than naming her in a sentence.
--
-- `body` stays markdown on purpose. The existing entries carry file:line
-- pointers, quoted errors and the incident that produced each item, and
-- flattening that into plain text would lose the part that makes them useful.
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  -- open -> in_progress -> done, with blocked as a side state for work that is
  -- waiting on someone outside the codebase (a WABA payment method, a decision
  -- from Justin). Deliberately not an enum: the lifecycle here is a convention
  -- between three people, not a state machine anything computes on.
  status text not null default 'open',
  -- 1 highest. Three levels, because a backlog this size cannot support more
  -- and a five-point scale just becomes "everything is a 3".
  priority integer not null default 2,
  -- Which part of the system: bot, delivery, money, whatsapp, dashboard, data.
  -- Free text; the filter offers whatever is actually in use.
  area text,
  -- admin_users.email. Null means nobody has picked it up.
  assignee text,
  -- What the task is about, when it is about something. Both nullable, because
  -- most tasks are about the code and not about a record.
  customer_id uuid references public.customers(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  -- Set when status becomes 'blocked'; the sentence explaining what is being
  -- waited on. Kept separate from body so the list can show it inline.
  blocked_on text,
  -- A dated item that will go wrong on its own. TASKS.md carried these as a
  -- section heading ("Live this week"); a column lets the list sort by it.
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Set when status becomes 'done'. Nothing derives done-ness from it — status
  -- is the truth — but it is what makes "what shipped this week" answerable.
  done_at timestamptz
);

-- The list view: open work, highest priority first, oldest first within a
-- priority. Done tasks are excluded from the default view rather than deleted.
create index if not exists tasks_open_idx
  on public.tasks (priority, created_at)
  where status <> 'done';

create index if not exists tasks_customer_idx
  on public.tasks (customer_id)
  where customer_id is not null;

create index if not exists tasks_order_idx
  on public.tasks (order_id)
  where order_id is not null;

alter table public.tasks enable row level security;

-- Dashboard-only, and every write goes through an API route so edit_log can
-- record who did it (CLAUDE.md, "a dashboard write must go through an API
-- route"). The browser client never touches this table directly.
create policy "service role manages tasks"
  on public.tasks for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table public.tasks is
  'The work queue, replacing TASKS.md. Read at session start; every write goes through /api/tasks so edit_log records the actor.';
comment on column public.tasks.status is
  'open | in_progress | blocked | done. Convention between admins, not a computed state machine.';
comment on column public.tasks.priority is
  '1 = highest, 3 = lowest.';
comment on column public.tasks.blocked_on is
  'What the task is waiting on, when status = blocked. Shown inline in the list.';
