-- Watermarks for the two unconditional refresh loops.
--
-- Principle 10 says a repeating fetch polls a watermark rather than the data.
-- It was applied to the inbox message poll and to nothing else, so two loops
-- were still re-downloading their whole payload on a fixed timer:
--
--  * the server-side settings cache reloaded five tables every 60 seconds,
--    measured at 20,621 bytes a refresh — 28 MB a day, 849 MB a month, burned
--    whether or not anyone was using the app and whether or not anything had
--    changed. `area_neighborhoods` alone was 15 KB of that and grows with every
--    neighbourhood added.
--  * the inbox flag sweep called the full refresh every 60 seconds per visible
--    tab — a 17.9 KB thread page, up to ~1 GB a month across four admins.
--
-- Both now read a watermark first. That needs two things this schema did not
-- have.
--
-- 1. An `updated_at` that actually moves. The project has no triggers at all
--    and `updated_at` is a plain `default now()`, which fires on insert and
--    never again. Every write path here — the settings upsert, the template
--    update, the pricing update — leaves it at its original value, so a
--    `max(updated_at)` watermark over them would never move and the bot would
--    serve a frozen price list forever. A trigger is the only version of this
--    that cannot be silently undone by the next route that forgets the column.
--
-- 2. A count alongside it. A trigger plus `default now()` covers inserts and
--    updates, but a DELETE moves `max(updated_at)` only when the deleted row
--    happened to be the newest one. Deleting a neighbourhood or a chatbot
--    instruction is an ordinary thing to do here, so the watermark carries
--    `count:max(updated_at)` per table and any of the three moves it.

-- One shared trigger function. `before update` so the value lands in the row
-- being written rather than costing a second write.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Maintains updated_at on every UPDATE. Attached to the tables whose freshness a cache watermark depends on — without it updated_at only reflects insertion time, because no write path in this app sets the column by hand.';

-- area_neighborhoods and customer_flags never had the column.
alter table public.area_neighborhoods
  add column if not exists updated_at timestamptz not null default now();

alter table public.customer_flags
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

drop trigger if exists pricing_tiers_set_updated_at on public.pricing_tiers;
create trigger pricing_tiers_set_updated_at
  before update on public.pricing_tiers
  for each row execute function public.set_updated_at();

drop trigger if exists message_templates_set_updated_at on public.message_templates;
create trigger message_templates_set_updated_at
  before update on public.message_templates
  for each row execute function public.set_updated_at();

drop trigger if exists chatbot_instructions_set_updated_at on public.chatbot_instructions;
create trigger chatbot_instructions_set_updated_at
  before update on public.chatbot_instructions
  for each row execute function public.set_updated_at();

drop trigger if exists area_neighborhoods_set_updated_at on public.area_neighborhoods;
create trigger area_neighborhoods_set_updated_at
  before update on public.area_neighborhoods
  for each row execute function public.set_updated_at();

drop trigger if exists customer_flags_set_updated_at on public.customer_flags;
create trigger customer_flags_set_updated_at
  before update on public.customer_flags
  for each row execute function public.set_updated_at();

-- The settings cache's whole freshness question, as one short string.
--
-- Five `select count(*), max(updated_at)` over tables of a few hundred rows,
-- returned as ~120 bytes against the 20 KB it replaces. It is one request
-- rather than five, so it also takes the cache from 300 requests an hour to 60.
--
-- `chatbot_instructions` is filtered to the active rows because that is what
-- the cache loads: flipping is_active off is a change the bot must see, and it
-- moves the count.
create or replace function public.settings_cache_watermark()
returns text
language sql
stable
as $$
  select concat_ws('|',
    (select concat(count(*), ':', coalesce(max(updated_at)::text, '-')) from public.settings),
    (select concat(count(*), ':', coalesce(max(updated_at)::text, '-')) from public.pricing_tiers where subcontractor_id is null),
    (select concat(count(*), ':', coalesce(max(updated_at)::text, '-')) from public.message_templates),
    (select concat(count(*), ':', coalesce(max(updated_at)::text, '-')) from public.chatbot_instructions where is_active = true),
    (select concat(count(*), ':', coalesce(max(updated_at)::text, '-')) from public.area_neighborhoods)
  );
$$;

comment on function public.settings_cache_watermark() is
  'One string that changes whenever anything the settings cache holds changes. Read it on a timer; reload the cache only when it differs from the last value. Covers insert, update and delete via count:max(updated_at) per table.';

grant execute on function public.settings_cache_watermark() to service_role;
