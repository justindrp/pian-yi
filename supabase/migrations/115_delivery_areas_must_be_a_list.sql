-- Migration 115: `delivery_areas` holds a JSON list, and one row held `{}`.
--
-- Migration 113 inserted Cahaya 99 with `delivery_areas` set to '{}' — the
-- Postgres array literal for "empty", which is right for `delivery_days` and
-- wrong here, because `delivery_areas` is jsonb. It landed as an empty JSON
-- *object*, and `?? []` does not catch an object: every reader that trusts the
-- column to be a list threw on it. The Subcontractors tab in Settings died
-- whole ("(e.delivery_areas ?? []).join is not a function") for every admin,
-- on a row for a kitchen used once in Desember 2025 and inactive ever since.
--
-- Fixed here, and constrained so the next hand-written insert fails loudly at
-- the write instead of quietly at the read. The application layer normalizes
-- as well (`asAreas()` in `src/lib/subcontractors/areas.ts`) — the constraint
-- protects the data, the normalizer protects the screens from data that
-- predates the constraint.

UPDATE subcontractors
   SET delivery_areas = '[]'::jsonb
 WHERE delivery_areas IS NOT NULL
   AND jsonb_typeof(delivery_areas::jsonb) <> 'array';

ALTER TABLE subcontractors
  ADD CONSTRAINT subcontractors_delivery_areas_is_array
  CHECK (
    delivery_areas IS NULL
    OR jsonb_typeof(delivery_areas::jsonb) = 'array'
  );
