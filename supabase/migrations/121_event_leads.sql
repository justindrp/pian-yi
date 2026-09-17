-- An event enquiry, from the brief to won or lost.
--
-- An event is never priced off the ladder and never run through extract_order:
-- it is tendered to the kitchens and quoted by hand, so it has no `orders` row
-- and no `daily_deliveries` row until somebody writes both. That is correct —
-- creating the order is what sends the bank details, and pricing one early is
-- the 2026-08-25 failure. The cost is that between the brief and the tender the
-- lead exists nowhere the app can see: no state, no deadline, no follow-up, no
-- "quote sent, waiting on her". The Breeze's Friday 16:00 tender deadline was
-- tracked only because a human filed it as a task, and the 70-porsi 1 Oktober
-- lead went three days in silence for the same reason.
--
-- Deliberately its own table rather than a status on the escalation. The
-- escalation expires: `expire-pending-questions` clears `pending_bot_response`
-- after `settings.pending_question_expiry_hours` (migration 104), so a
-- lifecycle parked there disappears 48 hours after the customer stops chasing
-- it — which is exactly when a quoted event most needs chasing. A lead also
-- outlives its flag and a customer may hold more than one over time, and a
-- per-customer flags row can hold only the latest.
--
-- `event_date` is nullable because a brief often arrives before the date is
-- fixed, and a row we cannot date is a row no sweep may age.
create table if not exists event_leads (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  event_date date,
  portions integer,
  venue text,
  brief text,
  -- brief: we have the request, nothing sent to a kitchen yet
  -- tendered: the kitchens have it, waiting on their bids
  -- quoted: the customer has a price, waiting on them
  -- won: they accepted — from here it is a hand-written order, not a lead
  -- lost: they declined, went elsewhere, or the date passed unanswered
  status text not null default 'brief'
    check (status in ('brief', 'tendered', 'quoted', 'won', 'lost')),
  -- What we quoted them, per portion, once a kitchen has bid. Never a tier.
  quoted_price_per_portion integer,
  -- Which kitchen won the tender, once one has.
  subcontractor_id uuid references subcontractors(id) on delete set null,
  notes text,
  -- Stamped by the sweep so an admin is told once a day about one lead, not
  -- once an hour. Null = never pushed about.
  last_nudged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

-- The sweep and the dashboard both read open leads by date.
create index if not exists idx_event_leads_open
  on event_leads (status, event_date);
create index if not exists idx_event_leads_customer
  on event_leads (customer_id);

comment on table event_leads is
  'One one-off event enquiry, brief through won/lost. Never an orders row until it is won and an admin writes one by hand: creating the order is what sends the bank details.';

-- Enable RLS; service-role admin client bypasses it for API writes.
alter table event_leads enable row level security;

create policy "authenticated manage event_leads"
  on event_leads
  for all to authenticated using (true) with check (true);

-- How close an event may get before an open lead is pushed to the admins.
-- Three days: the tender takes a day to come back and the kitchen shops the
-- day before, so a lead still unanswered at H-3 is the last point where an
-- admin can do anything about it.
insert into settings (key, value, description)
values (
  'event_lead_nudge_days',
  '3',
  'An open event lead is pushed to the admins once a day when the event is this many days away or closer.'
)
on conflict (key) do nothing;
