ALTER TABLE customers RENAME COLUMN district TO sub_area;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address_type text;
