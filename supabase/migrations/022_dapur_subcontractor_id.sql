-- Add customer-facing nickname to subcontractors (e.g. "Dapur 1", "Dapur 2")
ALTER TABLE subcontractors ADD COLUMN customer_nickname text;

-- Add per-order subcontractor selection (customer chooses during WhatsApp order flow)
ALTER TABLE orders ADD COLUMN subcontractor_id uuid REFERENCES subcontractors(id);
CREATE INDEX idx_orders_subcontractor_id ON orders(subcontractor_id);
