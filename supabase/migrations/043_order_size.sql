ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS size text NOT NULL DEFAULT 's' CHECK (size IN ('s', 'm'));
