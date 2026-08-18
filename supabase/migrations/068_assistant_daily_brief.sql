-- One row per day on which the assistant's automatic morning briefing has been
-- sent, so it fires once across every device instead of once per device.
--
-- The client used to guard this with localStorage, which is per-browser: an
-- admin opening the assistant on their phone got the briefing, then opening it
-- on their laptop got a second identical one, because the laptop's localStorage
-- had never heard of the phone's.
--
-- The date is the primary key, which is the whole mechanism: the first client to
-- insert wins, and a second one racing it gets a unique violation rather than a
-- duplicate briefing. Same shape as the processed_messages guard.
--
-- Global, not per-admin, matching assistant_conversations — the assistant's
-- threads are already shared by all three admins, so one briefing a day is one
-- briefing for the business, not one per person.
create table if not exists public.assistant_daily_briefs (
  -- Jakarta date (see jakartaDateString), not UTC: the briefing is a
  -- start-of-workday thing and WIB is UTC+7, so a UTC date would roll over at
  -- 07:00 local and hand out a second briefing mid-morning.
  brief_date date primary key,
  claimed_at timestamptz not null default now()
);

alter table public.assistant_daily_briefs enable row level security;

-- Claimed server-side through the service-role client only.
create policy "service role manages assistant_daily_briefs"
  on public.assistant_daily_briefs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
