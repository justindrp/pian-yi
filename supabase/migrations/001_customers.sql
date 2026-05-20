CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text UNIQUE NOT NULL,
  name text,
  address text,
  area text,
  meal_time_preference text,
  custom_schedule jsonb,
  delivery_phone text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_customers_phone ON customers (phone_number);
CREATE INDEX idx_customers_area ON customers (area);
CREATE INDEX idx_customers_created_at ON customers (created_at);

CREATE TABLE customer_rate_limits (
  customer_id uuid PRIMARY KEY REFERENCES customers (id) ON DELETE CASCADE,
  daily_message_count int DEFAULT 0,
  daily_token_count int DEFAULT 0,
  minute_message_count int DEFAULT 0,
  last_message_at timestamptz,
  last_reset_at timestamptz DEFAULT now()
);

CREATE TABLE customer_flags (
  customer_id uuid PRIMARY KEY REFERENCES customers (id) ON DELETE CASCADE,
  is_blacklisted boolean DEFAULT false,
  is_suspicious boolean DEFAULT false,
  needs_human_review boolean DEFAULT false,
  vip_status boolean DEFAULT false,
  escalated_to_human boolean DEFAULT false,
  escalation_reason text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE customer_state (
  customer_id uuid PRIMARY KEY REFERENCES customers (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'new',
  updated_at timestamptz DEFAULT now()
);
