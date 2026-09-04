-- Each kitchen carries its own price list image.
--
-- `settings.price_list_image_url` is one picture of one ladder, and it was the
-- truth while every customer bought at the same rates. Migration 098 gave each
-- kitchen its own ladder, so that single image is now correct for whichever
-- kitchen happens to match the house ladder and wrong by up to Rp 16.000 a
-- portion for the others — Dapur Monstera's real bottom tier is Rp 45.000
-- against the house sheet's Rp 29.000. The welcome sequence sends that image
-- before the customer has said anything, so the wrong number is the first
-- thing they read.
--
-- The customer picks their kitchen, so they are shown that kitchen's sheet.
-- `scripts/price-list.ts` renders one per active kitchen off `tiersForKitchen()`
-- plus that kitchen's own `delivery_areas` and `offers_size_m`, and the URL of
-- each lands here. `settings.price_list_image_url` stays as the fallback for a
-- kitchen with no sheet of its own yet, the same way `subcontractor_id IS NULL`
-- is the fallback ladder.
alter table subcontractors
  add column if not exists price_list_image_url text;

comment on column subcontractors.price_list_image_url is
  'This kitchen''s own price list image. NULL falls back to settings.price_list_image_url.';
