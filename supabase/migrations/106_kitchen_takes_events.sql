-- Which kitchens we may tender a one-off event to.
--
-- This is an overlay, not a partition. Daily and event are not exclusive: a
-- kitchen that runs a daily route can also cook an event, and an event-only
-- kitchen may start a route later. Splitting `subcontractors` into two lists
-- would force an either/or the business does not have, so a kitchen that does
-- both simply carries both flags.
--
-- `is_active` keeps its existing meaning untouched — runs a daily route — and
-- every read of it (activeDeliveryAreas, kitchen sheets, the ladders, the
-- prompt) is unaffected. Before this column the one kitchen we had actually
-- tendered to, Dapur Uma Ceo, was distinguishable from ten prospects we never
-- signed only by a paragraph in `notes`, which is the stale-prose failure this
-- schema keeps rediscovering.
alter table subcontractors
  add column if not exists takes_events boolean not null default false;

comment on column subcontractors.takes_events is
  'May be tendered a one-off event. Independent of is_active — a kitchen can do daily, events, both, or neither.';

-- Dapur Uma Ceo, added 2026-09-11 for the QBig BSD event on 12 September.
update subcontractors
   set takes_events = true
 where admin_phone = '+6287815984773';
