ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS portions_remaining integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_price_per_portion integer NOT NULL DEFAULT 0;

-- Backfill from existing non-cancelled orders using Weighted Average Cost
UPDATE customers c
SET
  portions_remaining = COALESCE((
    SELECT SUM(o.portions_remaining)
    FROM orders o
    WHERE o.customer_id = c.id
      AND o.status IN ('active', 'pending_payment', 'payment_proof_received', 'paused')
      AND o.portions_remaining > 0
  ), 0),
  avg_price_per_portion = COALESCE((
    SELECT CASE
      WHEN SUM(o.portions_remaining) > 0
        THEN SUM(o.portions_remaining * o.price_per_portion) / SUM(o.portions_remaining)
      ELSE 0
    END
    FROM orders o
    WHERE o.customer_id = c.id
      AND o.status IN ('active', 'pending_payment', 'payment_proof_received', 'paused')
      AND o.portions_remaining > 0
  ), 0);
