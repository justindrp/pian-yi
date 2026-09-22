-- Molls Kitchen is made ready to go live, and size M stops being one number
-- for everybody. The activation itself is migration 132.
--
-- Migration 130 recorded what Molls told us and deliberately left three things
-- alone, because each was a decision nobody had made yet. All three are made:
--
-- 1. **The ladder basis.** Justin approved "25.000 S" when we thought 20.000
--    was a delivered price. It is not — ongkir is charged on top and passed
--    through to the customer at cost (migration 085), so 20% on the food alone
--    is 14,3% on what the order really costs us. The ladder is anchored on
--    delivered cost instead, which is how every other kitchen's already works:
--    30.000 delivered / 0.8 = 37.500, less the 10.000 ongkir = 27.500 at the
--    20-24 tier, then the house offsets. Jennifer confirmed on 2026-09-22.
-- 2. **The M tambahan.** Molls bill 25.000 for M against 20.000 for S. The
--    gap is 5.000, which is 6.500 marked up — not the 4.000 in
--    `settings.size_m_surcharge`. See the column below.
-- 3. **The daily cost.** `cost_per_portion` still held 15.000, the rate Molls
--    quoted for the Agustus ICE BSD event, not the 20.000 they cook daily at.
--
-- It also re-states, idempotently, what was applied over the REST API while
-- these three were open: the Jakarta areas, the kecamatan and the ongkir rows.
-- A migration that only carries the leftovers cannot rebuild the database.

-- ---------------------------------------------------------------------------
-- The size M tambahan is per kitchen, the same way the ladder is
-- ---------------------------------------------------------------------------
--
-- `settings.size_m_surcharge` is Rp 4.000 and has been read as a fact about the
-- business since migration 078. It is a fact about *Thenie*: their M costs us
-- Rp 3.000 more (24.000 against 21.000), which is Rp 4.000 at Justin's 20%.
-- It survived because Thenie were the only kitchen cooking M. Molls are the
-- second, their gap is Rp 5.000, and one figure across both quotes Molls' M
-- Rp 2.500 a portion light on every tier — the same shape of silent loss
-- `tiersForKitchen()` exists to stop, and nothing in the order would look
-- wrong.
--
-- NULL means this kitchen has never been priced separately and the house
-- figure stands, exactly like `cost_per_portion_route1`. Thenie stay NULL: the
-- setting already holds their number, so writing 4.000 here would make two
-- places to change it. A stored 0 is a kitchen that really does throw the extra
-- dish in and is honoured as 0, never re-read as unset.
alter table subcontractors
  add column if not exists size_m_surcharge integer;

comment on column subcontractors.size_m_surcharge is
  'IDR added per size M portion at this kitchen. NULL = never priced separately, settings.size_m_surcharge (Thenie''s figure) applies. 0 = M really is free here.';

-- ---------------------------------------------------------------------------
-- The Jakarta kecamatan
-- ---------------------------------------------------------------------------
--
-- An area with no `area_neighborhoods` rows silently disables
-- `record_customer_area` for it, which is how the Daan Mogot Baru lead was
-- quoted every kitchen's ladder on 2026-09-22. Molls bring four Jakarta regions
-- nobody served, so each one needs its kecamatan before it is offered.
-- Jakarta Barat already has its 32 from that incident.
insert into area_neighborhoods (area, name)
values
  ('Jakarta Selatan', 'Jagakarsa'),
  ('Jakarta Selatan', 'Pasar Minggu'),
  ('Jakarta Selatan', 'Cilandak'),
  ('Jakarta Selatan', 'Pesanggrahan'),
  ('Jakarta Selatan', 'Kebayoran Lama'),
  ('Jakarta Selatan', 'Kebayoran Baru'),
  ('Jakarta Selatan', 'Mampang Prapatan'),
  ('Jakarta Selatan', 'Pancoran'),
  ('Jakarta Selatan', 'Tebet'),
  ('Jakarta Selatan', 'Setiabudi'),
  ('Jakarta Timur', 'Pasar Rebo'),
  ('Jakarta Timur', 'Ciracas'),
  ('Jakarta Timur', 'Cipayung'),
  ('Jakarta Timur', 'Makasar'),
  ('Jakarta Timur', 'Kramat Jati'),
  ('Jakarta Timur', 'Jatinegara'),
  ('Jakarta Timur', 'Duren Sawit'),
  ('Jakarta Timur', 'Cakung'),
  ('Jakarta Timur', 'Pulo Gadung'),
  ('Jakarta Timur', 'Matraman'),
  ('Jakarta Pusat', 'Tanah Abang'),
  ('Jakarta Pusat', 'Menteng'),
  ('Jakarta Pusat', 'Senen'),
  ('Jakarta Pusat', 'Johar Baru'),
  ('Jakarta Pusat', 'Cempaka Putih'),
  ('Jakarta Pusat', 'Kemayoran'),
  ('Jakarta Pusat', 'Sawah Besar'),
  ('Jakarta Pusat', 'Gambir'),
  ('Jakarta Utara', 'Penjaringan'),
  ('Jakarta Utara', 'Pademangan'),
  ('Jakarta Utara', 'Tanjung Priok'),
  ('Jakarta Utara', 'Koja'),
  ('Jakarta Utara', 'Kelapa Gading'),
  ('Jakarta Utara', 'Cilincing')
on conflict (area, name) do nothing;

-- ---------------------------------------------------------------------------
-- The kitchen row
-- ---------------------------------------------------------------------------
--
-- `cost_per_portion` 15.000 -> 20.000 is safe for the books: the Agustus event
-- is fully accrued (`rev_`/`cogs_` journals for 21-23 Agustus all exist) and
-- `accrueDeliveryDate()` is idempotent on those source ids, so the posted COGS
-- of 20p x Rp 15.000 a meal cannot be rewritten by a replay. Leaving it at the
-- event rate is the actual hazard — OPERATIONS.md: "a kitchen left on a
-- historic rate silently misprices every future accrual and every dapur bill".
--
-- Molls cook Senin-Sabtu, so `delivery_days` keeps the default. They are a
-- daily kitchen now as well as an event one, so `takes_events` stays true —
-- the flags are an overlay, not a partition (migration 106).
-- `is_active` and `offers_size_m` are NOT set here. They are migration 132,
-- on its own push, for two reasons:
--
--   * `dapurOptions` drops any kitchen with no `menu_image_url`, and Molls have
--     none yet. Flipping `is_active` alone puts the five Jakarta regions into
--     `activeDeliveryAreas()` while leaving no kitchen the bot can actually
--     offer in them — a lead told we deliver to their area and then given
--     nowhere to order from.
--   * `offers_size_m` before the code that reads `size_m_surcharge` is live
--     quotes Molls' M off the Rp 4.000 house setting, Rp 2.500 light a portion.
--     The column has to exist and be read first, which is this push.
update subcontractors
set cost_per_portion = 20000,
    cost_per_portion_m = 25000,
    size_m_surcharge = 6500,
    delivery_areas = '["Jakarta Timur","Jakarta Selatan","Jakarta Pusat","Jakarta Barat","Jakarta Utara"]'::jsonb,
    updated_at = now()
where id = 'ca6f3ac1-226c-4e3f-a610-fb54f84c4717';

-- ---------------------------------------------------------------------------
-- Ongkir, per region, charged through to the customer
-- ---------------------------------------------------------------------------
--
-- Ika revised this five times over two days before settling on per-address
-- rates: Rp 10.000 in Jaktim, Jaksel and Jakpus, Rp 15.000 in Jakbar and
-- Jakut. `subcontractor_neighborhoods` is an exclusion list, so every row here
-- is `can_deliver = true` with a price on it, the Apartemen Akasa shape from
-- migration 086 rather than the refusals of 085.
--
-- Per drop, not per portion, and `pricing_tiers` holds one ladder per kitchen —
-- so these rows are the only per-region lever there is. That is why the ladder
-- below is anchored on the 10.000 regions and Jakbar/Jakut simply earn less.
insert into subcontractor_neighborhoods
  (subcontractor_id, neighborhood_id, can_deliver, surcharge_per_delivery)
select
  'ca6f3ac1-226c-4e3f-a610-fb54f84c4717',
  an.id,
  true,
  case an.area
    when 'Jakarta Barat' then 15000
    when 'Jakarta Utara' then 15000
    else 10000
  end
from area_neighborhoods an
where an.area in (
  'Jakarta Barat', 'Jakarta Pusat', 'Jakarta Selatan',
  'Jakarta Timur', 'Jakarta Utara'
)
on conflict (subcontractor_id, neighborhood_id) do update
set can_deliver = excluded.can_deliver,
    surcharge_per_delivery = excluded.surcharge_per_delivery,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- The ladder
-- ---------------------------------------------------------------------------
--
-- Anchored at 20-24 on delivered cost, then the house offsets: +2.000 at 5/6,
-- +1.000 at 10/12, -1.000 at 40-72, -2.000 at 120/144. Margin falls away from
-- the anchor by design — that is what wins the large package.
--
-- Without these rows `tiersForKitchen()` falls back to the house ladder, which
-- is Thenie's: it would have sold Molls' food at Rp 27.000 against a Rp 30.000
-- delivered cost. A kitchen is not safe to activate until its ladder exists,
-- which is the whole reason 130 left `is_active` alone.
insert into pricing_tiers (subcontractor_id, portions, price_per_portion)
values
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 5, 29500),
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 6, 29500),
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 10, 28500),
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 12, 28500),
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 20, 27500),
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 24, 27500),
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 40, 26500),
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 48, 26500),
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 60, 26500),
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 72, 26500),
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 120, 25500),
  ('ca6f3ac1-226c-4e3f-a610-fb54f84c4717', 144, 25500)
on conflict (subcontractor_id, portions) do update
set price_per_portion = excluded.price_per_portion;
