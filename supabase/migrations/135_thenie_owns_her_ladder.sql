-- Thenie's ladder is Thenie's, and there is no house ladder any more.
--
-- Migration 098 keyed `pricing_tiers` by kitchen and kept the existing twelve
-- rows as the house ladder (`subcontractor_id IS NULL`): what a kitchen with no
-- rows of its own was sold at, and what an order with no kitchen was priced
-- at. Those rows were always exactly Dapur Suplir's (Thenie's) prices, so the
-- "house" was one kitchen's ladder wearing everyone's name — a kitchen switched
-- on without its own rows would have sold at Thenie's rates against its own
-- cost, and an order whose dapur the bot never pinned down was quietly priced
-- as Thenie's while no kitchen sheet showed it.
--
-- The rows are copied onto Thenie's id unchanged, so no price moves. An active
-- kitchen must have a ladder of its own, the same way migration 134 requires
-- its price sheet. Pricing with no kitchen now refuses and asks the customer
-- which dapur (`createOrderFromExtraction`), rather than borrowing anyone's
-- prices.
--
-- Copied, not moved, because this lands in the same push as the code that
-- stops reading the NULL rows: the old build, still serving while Railway
-- deploys the new one, prices Thenie off the NULL rows and would find none.
-- Migration 136 deletes them and makes the column NOT NULL once the new build
-- is live.

INSERT INTO pricing_tiers (subcontractor_id, portions, price_per_portion)
SELECT '52cd5e62-da09-49c9-939c-2f1246566c40', portions, price_per_portion
FROM pricing_tiers
WHERE subcontractor_id IS NULL
ON CONFLICT DO NOTHING;

-- A CHECK cannot look at another table, so this is a trigger: switching a
-- kitchen on with no ladder is refused, rather than discovered the first time
-- a customer asks for a price.
CREATE OR REPLACE FUNCTION active_kitchen_needs_ladder()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_active AND NOT EXISTS (
    SELECT 1 FROM pricing_tiers WHERE subcontractor_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'dapur % has no pricing_tiers rows; add its ladder before activating it', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER active_kitchen_needs_ladder
  BEFORE INSERT OR UPDATE OF is_active ON subcontractors
  FOR EACH ROW
  WHEN (NEW.is_active)
  EXECUTE FUNCTION active_kitchen_needs_ladder();

-- The settings cache no longer holds `pricing_tiers`: it cached only the house
-- rows, and there are none. Every ladder is read per kitchen at the moment it
-- is quoted (`tiersForKitchen()`), so the watermark stops watching the table.
create or replace function public.settings_cache_watermark()
returns text
language sql
stable
as $$
  select concat_ws('|',
    (select concat(count(*), ':', coalesce(max(updated_at)::text, '-')) from public.settings),
    (select concat(count(*), ':', coalesce(max(updated_at)::text, '-')) from public.message_templates),
    (select concat(count(*), ':', coalesce(max(updated_at)::text, '-')) from public.chatbot_instructions where is_active = true),
    (select concat(count(*), ':', coalesce(max(updated_at)::text, '-')) from public.area_neighborhoods)
  );
$$;
