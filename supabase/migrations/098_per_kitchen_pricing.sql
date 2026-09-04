-- Each kitchen carries its own price ladder.
--
-- `pricing_tiers` was one ladder for the whole business, which was true while
-- one kitchen cooked everything. It stops being true the moment a second one
-- does: Thenie costs us 21.000 a portion, Santapin 22.000 and Homey 33.000, so
-- a single ladder either loses money on the expensive kitchen or overcharges on
-- the cheap one. Selling Homey's food at Thenie's 28.000 tier is a 5.000 loss
-- per portion, every portion, silently.
--
-- The ladder is keyed by kitchen, with the existing rows kept as the fallback:
-- `subcontractor_id IS NULL` is the house ladder every kitchen uses until it
-- has one of its own, and it is exactly Thenie's, so Thenie needs no rows.
-- Reads go through `tiersForKitchen()` (src/lib/pricing/tiers.ts), never a bare
-- select — a read that forgets the kitchen quotes the house ladder and looks
-- like it worked.
alter table pricing_tiers
  add column if not exists subcontractor_id uuid
    references subcontractors (id) on delete cascade;

alter table pricing_tiers drop constraint if exists pricing_tiers_pkey;

-- NULLS NOT DISTINCT so the house ladder cannot hold two rows for the same
-- size. Without it every null-kitchen row is unique against every other and the
-- fallback ladder silently accepts duplicates.
create unique index if not exists pricing_tiers_kitchen_portions_key
  on pricing_tiers (subcontractor_id, portions) nulls not distinct;

comment on column pricing_tiers.subcontractor_id is
  'The kitchen this ladder belongs to. NULL is the house ladder, used by any kitchen with no rows of its own.';

-- What we knock off a portion when the customer does not want rice.
--
-- Santapin and Homey both sell dengan nasi and tanpa nasi, and the gap is flat
-- across their whole ladder — 2.500 and 5.000 a portion respectively — so this
-- is one number per kitchen rather than a second ladder per kitchen. Null means
-- the kitchen does not sell a box without rice, which is Thenie: their price is
-- the same either way, so there is nothing to knock off and nothing to offer.
alter table subcontractors
  add column if not exists no_rice_discount integer;

comment on column subcontractors.no_rice_discount is
  'IDR off per portion for a tanpa-nasi box, flat across every tier. NULL = this kitchen does not sell one.';

-- Which weekdays this kitchen actually cooks.
--
-- Senin-Sabtu was a fact about the business because Thenie works Saturdays.
-- Homey does not: their September menu grid has five columns and no Sabtu, so
-- a Saturday row on their sheet is food nobody is cooking. ISO weekday numbers,
-- 1 = Senin through 7 = Minggu; `isDeliveryDay()` still closes Minggu and the
-- libur nasional for everybody, and this narrows it further per kitchen.
alter table subcontractors
  add column if not exists delivery_days smallint[] not null default '{1,2,3,4,5,6}';

comment on column subcontractors.delivery_days is
  'ISO weekdays this kitchen cooks (1 = Senin). Narrows the global Senin-Sabtu; never widens it past isDeliveryDay().';

-- Santapin: the rate they quoted us, replacing the 19.500 the row still held
-- from before they re-priced. Their menu runs Senin-Sabtu with a different dish
-- for lunch and dinner, so `same_menu_both_meals` stays false.
update subcontractors
   set cost_per_portion  = 22000,
       no_rice_discount  = 2500
 where name = 'Santapin';

insert into pricing_tiers (subcontractor_id, portions, price_per_portion)
select s.id, t.portions, t.price
  from subcontractors s
  cross join (values
    (5, 30500), (6, 30500),
    (10, 29500), (12, 29500),
    (20, 28500), (24, 28500),
    (40, 27500), (48, 27500), (60, 27500), (72, 27500),
    (120, 26500), (144, 26500)
  ) as t(portions, price)
 where s.name = 'Santapin'
on conflict (subcontractor_id, portions) do update
   set price_per_portion = excluded.price_per_portion;

-- Homey, inactive until their menu card is rendered and their packaging is
-- settled. `delivery_areas` is deliberately narrower than the coverage they
-- advertise: their own list runs to Jakarta, Bekasi and Surabaya, and
-- `activeDeliveryAreas()` unions the active kitchens' areas into what the bot
-- offers, so activating them with their full list would advertise cities we do
-- not operate in.
insert into subcontractors (
  name, customer_nickname, admin_phone, is_active,
  cost_per_portion, no_rice_discount, offers_size_m, same_menu_both_meals,
  delivery_areas, delivery_days,
  lunch_window_start_min, lunch_window_end_min,
  dinner_window_start_min, dinner_window_end_min,
  notes
) values (
  'Homey Catering', 'Dapur Monstera', '+6281299307900', false,
  33000, 5000, false, true,
  '["BSD Baru", "BSD Lama", "Gading Serpong", "Alam Sutera"]'::json,
  '{1,2,3,4,5}',
  540, 720,   -- pengiriman pagi 09.00-12.00, from their own price sheet
  900, 1080,  -- pengiriman sore 15.00-18.00
  'Senin-Jumat only. One dish set per date, so pagi and sore are the same menu. Their price list is public (homeycatering.com, Instagram, Play Store) and their packaging carries their branding — a customer learns the kitchen on delivery day unless they box for us unbranded.'
)
on conflict do nothing;

insert into pricing_tiers (subcontractor_id, portions, price_per_portion)
select s.id, t.portions, t.price
  from subcontractors s
  cross join (values
    (5, 45000), (6, 45000),
    (10, 44000), (12, 44000),
    (20, 43000), (24, 43000),
    (40, 42000), (48, 42000), (60, 42000), (72, 42000),
    (120, 41000), (144, 41000)
  ) as t(portions, price)
 where s.name = 'Homey Catering'
on conflict (subcontractor_id, portions) do update
   set price_per_portion = excluded.price_per_portion;
