-- The house ladder goes (second half of migration 135).
--
-- 135 copied the twelve `subcontractor_id IS NULL` rows onto Dapur Suplir
-- (Thenie), whose prices they always were, and shipped with the code that
-- stops reading them. With that build live nothing reads the NULL rows, so
-- they go, and the column becomes NOT NULL so a house ladder cannot come back.

DELETE FROM pricing_tiers WHERE subcontractor_id IS NULL;

ALTER TABLE pricing_tiers ALTER COLUMN subcontractor_id SET NOT NULL;

COMMENT ON COLUMN pricing_tiers.subcontractor_id IS
  'The kitchen this ladder belongs to. Required (migration 136): there is no house ladder, and a kitchen with no rows cannot be priced.';
