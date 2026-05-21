CREATE TABLE delivery_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz DEFAULT now(),
  sender_phone text,
  subcontractor_id uuid REFERENCES subcontractors (id),
  whatsapp_message_id text UNIQUE,
  caption text,
  image_url text,
  matched_customer_id uuid REFERENCES customers (id),
  matched_delivery_id uuid,
  match_confidence float,
  match_method text,
  status text DEFAULT 'pending',
  sent_to_customer_at timestamptz,
  sent_by text
);

CREATE INDEX idx_delivery_proofs_status ON delivery_proofs (status);
CREATE INDEX idx_delivery_proofs_received_at ON delivery_proofs (received_at);
CREATE INDEX idx_delivery_proofs_subcontractor_id ON delivery_proofs (subcontractor_id);

CREATE TABLE daily_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_date date NOT NULL,
  customer_id uuid REFERENCES customers (id),
  order_id uuid REFERENCES orders (id),
  meal_type text NOT NULL,
  portions int NOT NULL,
  subcontractor_id uuid REFERENCES subcontractors (id),
  status text DEFAULT 'scheduled',
  delivery_proof_id uuid REFERENCES delivery_proofs (id),
  feedback_sentiment text,
  feedback_message text,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (delivery_date, customer_id, meal_type)
);

CREATE INDEX idx_daily_deliveries_date ON daily_deliveries (delivery_date);
CREATE INDEX idx_daily_deliveries_customer_id ON daily_deliveries (customer_id);
CREATE INDEX idx_daily_deliveries_subcontractor_id ON daily_deliveries (subcontractor_id);
CREATE INDEX idx_daily_deliveries_status ON daily_deliveries (status);

-- Back-reference from delivery_proofs to daily_deliveries
ALTER TABLE delivery_proofs
ADD CONSTRAINT fk_delivery_proofs_matched_delivery
  FOREIGN KEY (matched_delivery_id) REFERENCES daily_deliveries (id);
