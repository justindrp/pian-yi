ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS ad_creative text,
  ADD COLUMN IF NOT EXISTS first_message text,
  ADD COLUMN IF NOT EXISTS converted_at timestamptz,
  ADD COLUMN IF NOT EXISTS package text,
  ADD COLUMN IF NOT EXISTS total_portions integer,
  ADD COLUMN IF NOT EXISTS total_payment integer,
  ADD COLUMN IF NOT EXISTS promo_used text,
  ADD COLUMN IF NOT EXISTS converted_to_subscription boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notes text;

CREATE INDEX IF NOT EXISTS customers_ad_creative_idx ON customers(ad_creative);
CREATE INDEX IF NOT EXISTS customers_converted_at_idx ON customers(converted_at);
