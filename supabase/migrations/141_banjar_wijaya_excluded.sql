-- No kitchen delivers to Banjar Wijaya (Cipondoh, Kota Tangerang) — Justin,
-- 2026-09-26. With nothing placed there, katerloka.com's location match sent a
-- visitor standing in it to Alam Sutera, whose northern clusters are 2–3 km
-- away and inside the 4 km reach. An excluded row with a point makes the match
-- answer "not served" there, and puts the name in the bot's refusal block.
-- Filed under Alam Sutera, as Synergy Building is (migration 094), because that
-- is the area it was being mistaken for; `excluded` is what the row says.
insert into public.area_neighborhoods (area, name, excluded, lat, lng) values
  ('Alam Sutera', 'Banjar Wijaya', true, -6.196723, 106.6583303)
on conflict (area, name) do update
  set excluded = true, lat = excluded.lat, lng = excluded.lng;
