-- area/delivery_address/maps_link on orders duplicated customer-level data
-- (customers.area/address/google_maps_link), causing drift when only one
-- side got updated (e.g. delivery_route left stale after manual order
-- creation). Customer address rarely changes; address_2 already covers
-- the rare move case. Drop the order-level copies.
alter table orders drop column if exists area;
alter table orders drop column if exists delivery_address;
alter table orders drop column if exists maps_link;
