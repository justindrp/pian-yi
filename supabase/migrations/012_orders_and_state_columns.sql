-- Orders: new tracking columns (reminder_sent_at already exists from migration 003)
ALTER TABLE orders
ADD COLUMN followup_sent_at timestamptz,
ADD COLUMN abandoned_recovery_sent_at timestamptz;

-- Customer state: reactivation tracking for lapsed customer cron
ALTER TABLE customer_state
ADD COLUMN reactivation_sent_at timestamptz,
ADD COLUMN reactivation_count int DEFAULT 0;
