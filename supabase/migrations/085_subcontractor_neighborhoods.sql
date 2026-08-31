-- Coverage is per kitchen at the neighborhood level, not just per area.
--
-- `subcontractors.delivery_areas` says Thenie serves BSD Lama and Alam Sutera,
-- and on 2026-08-31 Thenie refused two addresses inside them: Apartemen Akasa
-- and Kost Casa Living. It also charges Rp 5.000 on some BSD Lama drops. There
-- was nowhere to write either fact, so the bot would have kept selling to both
-- places and the kitchen would have kept refusing them.
--
-- Exclusion list, not an allowlist: a row here is a kitchen saying "not this
-- one". No row means the kitchen serves the neighborhood at its normal rate,
-- which is true of every address nobody has asked about.
create table if not exists subcontractor_neighborhoods (
  id uuid primary key default gen_random_uuid(),
  subcontractor_id uuid not null references subcontractors(id) on delete cascade,
  neighborhood_id uuid not null references area_neighborhoods(id) on delete cascade,
  can_deliver boolean not null default true,
  -- Rp per drop, not per portion: the courier makes one trip whether it carries
  -- one portion or four.
  surcharge_per_delivery integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subcontractor_id, neighborhood_id)
);

create index if not exists idx_subcontractor_neighborhoods_sub
  on subcontractor_neighborhoods (subcontractor_id);

-- Enable RLS; service-role admin client bypasses it for API writes.
alter table subcontractor_neighborhoods enable row level security;

create policy "authenticated manage subcontractor_neighborhoods"
  on subcontractor_neighborhoods
  for all to authenticated using (true) with check (true);

-- The surcharge is charged through to the customer, so an order snapshots both
-- the rate it was sold at and what that added to total_price — the same reason
-- price_per_portion is frozen at creation.
alter table orders
  add column if not exists delivery_surcharge_per_delivery integer not null default 0,
  add column if not exists delivery_surcharge_total integer not null default 0;

-- Akasa was in nobody's neighborhood list; Casa Living already was.
insert into area_neighborhoods (area, name)
values ('BSD Lama', 'Apartemen Akasa')
on conflict (area, name) do nothing;

-- What Thenie said on 2026-08-31, in the group chat: "Kost Casa living tidak
-- bisa", "Apartemen Akasa tidak bisa".
insert into subcontractor_neighborhoods (subcontractor_id, neighborhood_id, can_deliver)
select s.id, n.id, false
from subcontractors s
cross join area_neighborhoods n
where s.name = 'Thenie'
  and (n.area, n.name) in (('BSD Lama', 'Apartemen Akasa'), ('Alam Sutera', 'Casa Living'))
on conflict (subcontractor_id, neighborhood_id)
do update set can_deliver = false, updated_at = now();
