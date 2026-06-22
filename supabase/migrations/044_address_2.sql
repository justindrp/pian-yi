-- Add second delivery address to customers
alter table customers
  add column address_2 text,
  add column area_2 text,
  add column sub_area_2 text,
  add column google_maps_link_2 text;

-- Track which address was used per delivery (1 = address_1, 2 = address_2)
alter table daily_deliveries
  add column address_slot smallint not null default 1 check (address_slot in (1, 2));
