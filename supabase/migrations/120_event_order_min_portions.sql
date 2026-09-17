-- The portion count at which a one-date order stops being a package and starts
-- being an event.
--
-- An event is tendered to the kitchens and priced from the bids that come back
-- (docs/OPERATIONS.md), so it must never reach `extract_order` — creating an
-- order is what sends the bank details, and no price exists yet. The prompt has
-- said so since the QBig BSD lead on 2026-09-11 and the prompt is all there was:
-- nothing in code could tell an event from a package, so a 20-box drop that
-- happened to divide by 5 was quoted off the personal ladder and billed.
--
-- The number is a setting rather than a constant because it is a judgment about
-- our own customers, not a fact about the world. 15 is what the live data
-- supports: the largest single-date subscription order we have taken is 12
-- portions, and the three events we have handled came in at 17, 20 and 40.
insert into settings (key, value, description)
values (
  'event_order_min_portions',
  '15',
  'Portions on a single delivery date at or above which an order is treated as an event: withheld from extract_order, escalated to an admin, priced by tender'
)
on conflict (key) do nothing;
