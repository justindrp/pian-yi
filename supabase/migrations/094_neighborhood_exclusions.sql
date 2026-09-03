-- A place we refuse, at the level of the business rather than one kitchen.
--
-- `area_neighborhoods` was include-only: a row said "this cluster belongs to
-- that area" and there was no row shape for "inside this area's footprint and
-- not deliverable". The only way to act on a refusal was to delete the row,
-- which stops the bot recognising the name and nothing more — the prompt's
-- nearest-area rule then rounds the unrecognised cluster into the nearest
-- served area and sells to it anyway, one turn later.
--
-- That has now happened twice. Taman Tekno was deleted on 2026-08-30 after the
-- bot quoted Sarah Sinaga for an address in BSD Lama we do not reach; Synergy
-- Building was deleted on 2026-09-03 after the building refused a lobby drop,
-- leaving the courier waiting ~15 minutes per drop while the rest of the route
-- ran late, and Naya, Cila and Winy were refunded.
--
-- `subcontractor_neighborhoods.can_deliver = false` already says "this kitchen
-- will not go here" and is enforced in extract_order. This column is the same
-- verdict with no kitchen behind it: nobody goes here, so no kitchen assignment
-- can rescue it and escalating to a human has nothing to offer.
alter table area_neighborhoods
  add column excluded boolean not null default false;

-- Both names come back as rows so the bot recognises them and refuses, instead
-- of not recognising them and rounding. Re-seeded rather than resurrected: the
-- originals were deleted, ids and all.
insert into area_neighborhoods (area, name, excluded) values
  ('Alam Sutera', 'Synergy Building', true),
  ('BSD Lama', 'Taman Tekno', true)
on conflict (area, name) do update set excluded = true;
