-- customers.phone_number had no normalization and no uniqueness, so the same
-- person could exist twice under "+628..." and "628...". That is exactly what
-- happened: the WhatsApp flow created one row and a later backfill script
-- created a second, orders landed on one and deliveries on the other, and an
-- audit that matched by name reported 135 phantom missing deliveries.
--
-- scripts/dedup-phone-format.ts merged the 11 existing groups and rewrote every
-- phone to the canonical "+62..." form before this ran. The partial index skips
-- IMPORT_ placeholders, which are import slugs rather than phone numbers and
-- are legitimately non-unique.
CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_number_unique
  ON customers (phone_number)
  WHERE phone_number IS NOT NULL
    AND phone_number NOT LIKE 'IMPORT_%';
