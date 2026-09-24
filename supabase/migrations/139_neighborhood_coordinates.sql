-- Where each neighbourhood is, so the public catalog can turn a visitor's
-- location into one of our areas (docs/ORDER_SITE.md, "Location on open").
-- The visitor's position is matched to the nearest neighbourhood server-side
-- and never stored; these columns hold only the neighbourhoods' own points.
--
-- Filled once by geocoding each name (OpenStreetMap Nominatim) and corrected
-- by hand where the geocoder missed. NULL = not placed yet; the matcher skips
-- the row, it does not guess.
alter table public.area_neighborhoods
  add column lat double precision,
  add column lng double precision;

comment on column public.area_neighborhoods.lat is
  'Latitude of the neighbourhood (WGS84). NULL = not placed; the catalog location matcher skips it.';
comment on column public.area_neighborhoods.lng is
  'Longitude of the neighbourhood (WGS84). NULL = not placed; the catalog location matcher skips it.';
