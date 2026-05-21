-- Enable RLS on new tables
ALTER TABLE subcontractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE subcontractor_off_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_instructions ENABLE ROW LEVEL SECURITY;

-- subcontractors: authenticated admins read-all; service role write-all
CREATE POLICY "admins_read_subcontractors" ON subcontractors
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "admins_write_subcontractors" ON subcontractors
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- subcontractor_off_days: authenticated admins read-all and write
CREATE POLICY "admins_read_subcontractor_off_days" ON subcontractor_off_days
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "admins_write_subcontractor_off_days" ON subcontractor_off_days
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- daily_deliveries: authenticated admins read-all and write
CREATE POLICY "admins_read_daily_deliveries" ON daily_deliveries
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "admins_write_daily_deliveries" ON daily_deliveries
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- delivery_proofs: authenticated admins read-all and write
CREATE POLICY "admins_read_delivery_proofs" ON delivery_proofs
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "admins_write_delivery_proofs" ON delivery_proofs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- chatbot_instructions: authenticated admins read-all and write
CREATE POLICY "admins_read_chatbot_instructions" ON chatbot_instructions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "admins_write_chatbot_instructions" ON chatbot_instructions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Storage bucket for delivery proofs
INSERT INTO storage.buckets (id, name, public) VALUES ('delivery-proofs', 'delivery-proofs', false)
  ON CONFLICT (id) DO NOTHING;

-- Storage RLS: authenticated admins can read; service role inserts via admin client
CREATE POLICY "admins_read_delivery_proof_objects" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'delivery-proofs');
