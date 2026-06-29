DELETE FROM pricing_tiers;

INSERT INTO pricing_tiers (portions, price_per_portion) VALUES
  (5, 29000),
  (10, 28000),
  (20, 27000),
  (40, 26000),
  (60, 26000),
  (120, 25000);
