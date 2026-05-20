CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  description text,
  updated_at timestamptz DEFAULT now(),
  updated_by text
);

CREATE TABLE pricing_tiers (
  portions int PRIMARY KEY,
  price_per_portion int NOT NULL,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE message_templates (
  key text PRIMARY KEY,
  template text NOT NULL,
  description text,
  updated_at timestamptz DEFAULT now()
);
