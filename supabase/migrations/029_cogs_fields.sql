-- COGS: cost per portion on subcontractors, add-on cost per portion on orders

ALTER TABLE subcontractors
  ADD COLUMN cost_per_portion int NOT NULL DEFAULT 0;

ALTER TABLE orders
  ADD COLUMN addon_cost_per_portion int NOT NULL DEFAULT 0;

-- Seed known costs (matched by name since UUIDs differ per environment)
UPDATE subcontractors SET cost_per_portion = 23000 WHERE name = 'Yuk Makan';
UPDATE subcontractors SET cost_per_portion = 21000 WHERE name = 'Thenie';
UPDATE subcontractors SET cost_per_portion = 21000 WHERE name = 'Perut Bahagia';
UPDATE subcontractors SET cost_per_portion = 19500 WHERE name = 'Santapin';
