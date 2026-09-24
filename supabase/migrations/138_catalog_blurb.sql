-- One line per kitchen for the public catalog (docs/ORDER_SITE.md, phase 4):
-- what a customer gets from this dapur, so four nicknames and four prices are
-- something to choose between. It was the last thing holding the catalog
-- behind the admin sign-in.
--
-- Public text. It describes the food and the delivery, never who cooks it: no
-- kitchen name, no neighbourhood, no packaging or branding a customer could
-- search for. Edited in the kitchen's dialog at /subcontractors. The first
-- four are written from each kitchen's menu_text and notes as of 2026-09-24.
alter table public.subcontractors add column catalog_blurb text;

comment on column public.subcontractors.catalog_blurb is
  'Public one-line description on the catalog. Describes the food and delivery only; never the kitchen''s identity or location.';

update public.subcontractors set catalog_blurb =
  'Masakan rumahan Nusantara dan oriental dengan nasi putih organik. Menu siang dan malam berbeda tiap hari.'
where id = 'f06fd140-26e1-49cf-ba2e-dadf521913a3';

update public.subcontractors set catalog_blurb =
  'Nasi, lauk utama, sayur dan sambal, satu menu untuk siang dan malam. Size M dapat satu lauk tambahan.'
where id = '52cd5e62-da09-49c9-939c-2f1246566c40';

update public.subcontractors set catalog_blurb =
  'Dua lauk, sayur, kerupuk dan sambal di tiap kotak. Menu siang dan malam sama tiap harinya.'
where id = '775e6ba3-7c33-40f6-97e7-e28868f272c6';

update public.subcontractors set catalog_blurb =
  'Masakan rumahan sederhana: lauk, sayur, gorengan dan sambal. Menu siang dan malam berbeda, diantar sekaligus sebelum jam 12 dalam kotak terpisah.'
where id = 'ca6f3ac1-226c-4e3f-a610-fb54f84c4717';
