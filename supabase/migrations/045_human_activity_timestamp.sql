ALTER TABLE customer_flags
  ADD COLUMN IF NOT EXISTS last_human_activity_at timestamptz;
