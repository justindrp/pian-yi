-- Santapin delivers to Bintaro.
--
-- Coverage belongs to the kitchen, not to the company: what Pian Yi offers is
-- the union of the active kitchens' `delivery_areas`, so this row is the only
-- place the fact can be written. Santapin is still inactive, so nothing reaches
-- a customer today — the moment they are activated, Bintaro becomes an area the
-- bot offers and a Bintaro address stops being out of coverage.
--
-- Bintaro rests on this kitchen alone: no other row carries it, so deactivating
-- Santapin removes the area outright.
--
-- The stale "BSD" entry is left as it is. It predates the BSD Baru / BSD Lama
-- split and matches no `area_neighborhoods` row, so once Santapin is active the
-- bot would offer "BSD" beside "BSD Baru" and "BSD Lama" as if it were a third
-- place. Yuk Makan carries the same value. Both want deciding together, not in
-- a migration about Bintaro.
update subcontractors
   set delivery_areas = '["BSD", "BSD Baru", "Gading Serpong", "Alam Sutera", "Bintaro"]'::json
 where name = 'Santapin';
