-- Karawaci had one neighbourhood (Cendana Cove), so the bot could only accept
-- Karawaci from a customer who typed that name or "Karawaci" itself, and
-- katerloka.com's location match put most of Lippo Village in Gading Serpong:
-- four of eleven Karawaci customers with a pinned link matched there
-- (task 2264f106). Names are the ones those customers typed (UPH, U Residence,
-- Permata Bunda, Taman Ubud) plus the township's landmarks; points are
-- OpenStreetMap's, except U Residence, which OSM places in the wrong Karawaci
-- and which is set from its residents' own pins, rounded to ~100 m.
-- Pinangsia is left out on purpose: it sits 0.9 km from Gading Serpong's
-- Sektor 1D and would take part of it.
insert into public.area_neighborhoods (area, name, lat, lng) values
  ('Karawaci', 'Lippo Village', -6.2341326, 106.600951),
  ('Karawaci', 'UPH', -6.2289614, 106.6119224),
  ('Karawaci', 'U Residence', -6.228, 106.608),
  ('Karawaci', 'Benton Junction', -6.2283432, 106.6089425),
  ('Karawaci', 'Supermall Karawaci', -6.2267202, 106.6072309),
  ('Karawaci', 'Siloam Lippo Village', -6.2252406, 106.59843),
  ('Karawaci', 'Villa Permata', -6.2241601, 106.5978591),
  ('Karawaci', 'Imperial Klub Golf', -6.2337919, 106.6026865),
  ('Karawaci', 'Palem Semi', -6.2176602, 106.6089645),
  ('Karawaci', 'Permata Bunda', -6.2245912, 106.593755),
  ('Karawaci', 'Taman Ubud', -6.2314852, 106.5867832),
  ('Karawaci', 'Binong Permai', -6.2489299, 106.5805308)
on conflict (area, name) do nothing;
