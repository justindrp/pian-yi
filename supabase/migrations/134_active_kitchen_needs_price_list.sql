-- An active kitchen has its own price list sheet, and nothing falls back.
--
-- Migration 099 gave each kitchen `price_list_image_url` and left
-- `settings.price_list_image_url` as the fallback for a kitchen whose sheet
-- had not been rendered yet. That fallback is the house sheet — Thenie's
-- ladder — so a kitchen that went live without its own would have shown its
-- customers Thenie's prices in the welcome and in `send_price_list`. The code
-- no longer falls back; this makes the missing sheet impossible instead of
-- quiet. Render and upload it with `scripts/price-list.ts --kitchen <name>
-- --upload` before switching the kitchen on.
--
-- All four active kitchens have a sheet at the time of writing, so this
-- validates against current data. Inactive kitchens are unconstrained: a
-- kitchen is set up before its sheet exists.

ALTER TABLE subcontractors
  ADD CONSTRAINT active_kitchen_needs_price_list_image
  CHECK (NOT is_active OR price_list_image_url IS NOT NULL);

COMMENT ON COLUMN subcontractors.price_list_image_url IS
  'This kitchen''s own price list image. Required while is_active (migration 134); there is no fallback.';
