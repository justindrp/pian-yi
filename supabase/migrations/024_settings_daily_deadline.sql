INSERT INTO settings (key, value, description)
VALUES ('order_deadline_daily_hour', '16', 'Cutoff hour for daily quota orders (24h format)')
ON CONFLICT (key) DO NOTHING;
