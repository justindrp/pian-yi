ALTER TABLE orders
  ADD COLUMN order_type text NOT NULL DEFAULT 'recurring'
    CHECK (order_type IN ('recurring', 'scheduled'));
