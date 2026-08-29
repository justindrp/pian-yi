-- Size M, for the kitchens that offer it.
--
-- Thenie (Dapur 1) sells two portion sizes off one weekly menu: S is nasi +
-- lauk utama + sayur + sambal, M adds the second side dish the menu image
-- lists as item 4. `orders.size` has held 's'/'m' since the dashboard toggle
-- shipped; nothing priced it, and no kitchen said whether it could cook it.
--
-- Which kitchens offer M is per kitchen, not global -- the same shape as
-- `delivery_areas`. Nothing may assume "M means Thenie": that is true today
-- only because Thenie is the one active kitchen, and it stops being true the
-- moment a second one is reactivated.
alter table subcontractors
  add column if not exists offers_size_m boolean not null default false,
  add column if not exists cost_per_portion_m integer,
  add column if not exists cost_per_portion_route1_m integer;

comment on column subcontractors.offers_size_m is
  'Whether this kitchen cooks size M at all. The bot may only offer M for a kitchen with this set.';
comment on column subcontractors.cost_per_portion_m is
  'What this kitchen bills us per M portion on route 2 (their courier). Null means it does not cook M.';
comment on column subcontractors.cost_per_portion_route1_m is
  'What this kitchen bills us per M portion on route 1 (our courier). Null falls back to cost_per_portion_m.';

update subcontractors
set offers_size_m = true,
    cost_per_portion_m = 24000,
    cost_per_portion_route1_m = 23000
where name = 'Thenie';

-- The customer-facing side is one number: M costs this much more per portion
-- than the S tier the package already lands on. It stacks on top of a contract
-- rate too, exactly like the nasi merah add-on, because it is a real extra
-- dish the kitchen bills us for either way.
insert into settings (key, value, description)
values (
  'size_m_surcharge',
  '4000',
  'Rupiah added per portion for size M, on top of the S tier or the contract rate'
)
on conflict (key) do nothing;
