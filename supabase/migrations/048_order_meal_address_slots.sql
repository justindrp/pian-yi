-- Standing per-meal delivery-address rule on an order. Each meal (lunch/dinner)
-- independently targets the customer's primary address (slot 1) or secondary
-- address (slot 2, customers.address_2). Generated daily_deliveries rows inherit
-- the matching slot; a per-day flip on the daily sheet still overrides.
-- Default 1 keeps existing orders unchanged (no backfill needed).
alter table orders
  add column lunch_address_slot  smallint not null default 1 check (lunch_address_slot  in (1, 2)),
  add column dinner_address_slot smallint not null default 1 check (dinner_address_slot in (1, 2));

comment on column orders.lunch_address_slot  is 'Standing address slot for this order''s lunch deliveries (1=primary, 2=secondary/address_2).';
comment on column orders.dinner_address_slot is 'Standing address slot for this order''s dinner deliveries (1=primary, 2=secondary/address_2).';
