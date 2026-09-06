-- A delivery row can be cooked by a kitchen other than the one its order was
-- bought from, and then it is not worth the order's rate.
--
-- Until now a package was one kitchen at one price: orders.price_per_portion
-- was the rate for every portion in it, and allocateDraws() refused to charge a
-- delivery to an order from another kitchen precisely because the rates differ
-- (Thenie Rp 29.000, Santapin Rp 30.500, Homey Rp 45.000 at the 5-porsi tier).
-- That left a customer who wants two kitchens in one week buying two packages,
-- and every kitchen's ladder starts at 5 porsi, so a 5-porsi customer could not
-- mix at all.
--
-- The split is per delivery: each row names the kitchen cooking it and, when
-- that is not the order's own kitchen, the rate that kitchen's ladder charges
-- for a package this size. Null means the row is worth orders.price_per_portion,
-- which is every row written before today.
--
-- Revenue recognition draws 2100 down by portions x rate per row, so the rate
-- has to travel with the row or a mixed order's deposit never clears.
ALTER TABLE daily_deliveries
  ADD COLUMN IF NOT EXISTS price_per_portion integer;

COMMENT ON COLUMN daily_deliveries.price_per_portion IS
  'What this delivery is worth per portion when its kitchen is not the order''s. Null = orders.price_per_portion.';
