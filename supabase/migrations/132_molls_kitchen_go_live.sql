-- Molls Kitchen starts taking daily orders.
--
-- Deliberately a second push. Migration 131 put everything in place — the
-- ladder, the ongkir rows, the kecamatan, the M tambahan column — and stopped
-- short of `is_active`, because it only becomes safe once something outside
-- the database is true: `is_active` publishes five Jakarta regions through
-- `activeDeliveryAreas()`, while `dapurOptions` drops any kitchen with no
-- `menu_image_url`. Flipping it early names an area the bot has no kitchen to
-- sell in — the Daan Mogot Baru failure (2026-09-22) pointed the other way.
-- The card and the price sheet were rendered and uploaded ahead of this push,
-- so that is now true.
--
-- Molls become the first kitchen in Jakarta Timur, Selatan, Pusat and Utara,
-- and the second in Jakarta Barat alongside Homey.

-- ---------------------------------------------------------------------------
-- The menu the card is drawn from
-- ---------------------------------------------------------------------------
--
-- Migration 130 stored Ika's WhatsApp message verbatim: bare weekday headings
-- with `Siang:` and `Malam:` on their own lines, dishes separated by hyphens.
-- `scripts/menu-card.ts` could not read a single day of it — `parseMenu()`
-- wants a dated line per day and splits dishes on commas, so the card rendered
-- with an empty header and zero panels, and the kitchen could not be activated
-- at all. The rotation below is the same food in the shape the renderer reads,
-- dated to `menu_week_start` (Senin 28 September).
--
-- The items are Ika's own and nothing was added to them. Rice is not listed
-- per day on purpose: it is in every box (`no_rice_discount = 0` — "tidak ada
-- potongan harga akan tetapi menu lauk di lebihkan"), the card's size legend
-- already prints "nasi + lauk + sayur + sambal", and naming it a fifth time in
-- each of the twelve lists overflowed every MALAM panel past the point the
-- render's font-fitter can recover, clipping the last dish off all six days.
--
-- This column is rewritten weekly from the dashboard from here on. It is
-- restated here only so a rebuild from the migrations produces a kitchen whose
-- card can actually be drawn.
update subcontractors
set menu_text = $menu$28 September s/d 3 Oktober 2026.
Menu siang dan menu malam berbeda tiap hari; nasi, lauk, sayur dan sambal sudah termasuk di setiap box.
Senin 28 September: Siang: Ayam Kecap, Tumis Buncis Wortel, Tempe Goreng, Sambal. Malam: Ikan Goreng Sambal Matah, Tumis Kangkung, Tahu, Sambal.
Selasa 29 September: Siang: Tongkol Balado, Capcay Sayur, Tahu Goreng, Sambal. Malam: Ayam Cabe Ijo, Tumis Kol Wortel, Bakwan Jagung, Sambal.
Rabu 30 September: Siang: Ayam Suwir Cabe Ijo, Tumis Kol Wortel, Bakwan Jagung, Sambal. Malam: Telur Teri Balado, Tumis Kangkung, Tempe Orek, Sambal.
Kamis 1 Oktober: Siang: Tongseng Ayam, Bakwan Jagung, Tempe Orek, Sambal. Malam: Ikan Bumbu Kuning, Sayur Bening, Perkedel Kentang, Sambal.
Jumat 2 Oktober: Siang: Ayam Semur, Cah Manisa, Tahu Goreng, Sambal. Malam: Tongkol Woku, Tumis Sawi Jagung, Tempe Goreng, Sambal.
Sabtu 3 Oktober: Siang: Ayam Goreng Terasi, Tumis Sawi Jagung, Perkedel Kentang, Sambal. Malam: Ayam Saus Tiram, Cah Pokcoy, Tahu Crispy, Sambal.$menu$,
    updated_at = now()
where id = 'ca6f3ac1-226c-4e3f-a610-fb54f84c4717';

-- ---------------------------------------------------------------------------
-- Live, size S only
-- ---------------------------------------------------------------------------
--
-- `offers_size_m` is written false rather than left alone. Migration 130 set
-- it true from Ika's quote, before anyone had decided to sell it and while M
-- could not be priced for this kitchen at all — the house Rp 4.000 is Thenie's
-- figure and Molls' gap is Rp 6.500. Jennifer chose "activate, S only" on
-- 2026-09-22 and production has been false since. Leaving the flag untouched
-- here would mean a database rebuilt from these migrations comes up selling an
-- M that production does not, which is exactly the drift 131 restated the REST
-- changes to avoid.
--
-- Turning M on later is this one flag: `size_m_surcharge` is already 6.500,
-- `cost_per_portion_m` 25.000, and the code that reads a per-kitchen tambahan
-- shipped with 131. The card and the price sheet both print their size legend
-- from `offers_size_m`, so both must be re-rendered on the day it changes.
update subcontractors
set is_active = true,
    offers_size_m = false,
    updated_at = now()
where id = 'ca6f3ac1-226c-4e3f-a610-fb54f84c4717';
