CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers (id),
  package_size int NOT NULL,
  price_per_portion int NOT NULL,
  total_price int NOT NULL,
  portions_per_delivery int NOT NULL,
  portions_lunch int DEFAULT 0,
  portions_dinner int DEFAULT 0,
  portions_remaining int NOT NULL,
  delivery_address text NOT NULL,
  area text NOT NULL,
  meal_time_preference text NOT NULL,
  custom_schedule jsonb,
  start_date date NOT NULL,
  pause_until date,
  status text NOT NULL DEFAULT 'pending_payment',
  confirmed_at timestamptz,
  paid_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  reminder_sent_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_orders_customer_id ON orders (customer_id);
CREATE INDEX idx_orders_status ON orders (status);
CREATE INDEX idx_orders_start_date ON orders (start_date);
CREATE INDEX idx_orders_created_at ON orders (created_at);
