ALTER TABLE customers
ADD COLUMN subcontractor_id uuid REFERENCES subcontractors (id) ON DELETE SET NULL;
