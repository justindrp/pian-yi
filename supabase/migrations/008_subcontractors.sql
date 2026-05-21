CREATE TABLE subcontractors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  admin_phone text,
  admin_phone_2 text,
  delivery_areas jsonb,
  notes text,
  is_active boolean DEFAULT true,
  late_delivery_count int DEFAULT 0,
  total_delivery_count int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_subcontractors_admin_phone ON subcontractors (admin_phone);
CREATE INDEX idx_subcontractors_is_active ON subcontractors (is_active);

CREATE TABLE subcontractor_off_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subcontractor_id uuid REFERENCES subcontractors (id) ON DELETE CASCADE,
  off_date date NOT NULL,
  reason text,
  created_by text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_subcontractor_off_days_sub ON subcontractor_off_days (subcontractor_id);
CREATE INDEX idx_subcontractor_off_days_date ON subcontractor_off_days (off_date);

INSERT INTO subcontractors (name, delivery_areas, notes) VALUES
  ('Santapin', '["BSD","Gading Serpong"]', 'Best taste. Occasionally delivers late.'),
  ('Thenie', '["Alam Sutera","Bintaro","Graha Raya"]', 'Always on time.');
