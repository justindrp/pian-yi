-- Aggregated delivery journals: one per meal_type per day instead of per customer row
-- source_id widened to text so we can use composite keys like "rev_2026-07-08_lunch"
ALTER TABLE journals ALTER COLUMN source_id TYPE text USING source_id::text;

-- Calculation breakdown shown in the expanded journal view
ALTER TABLE journals ADD COLUMN notes text;

-- Route-specific subcontractor cost (null = same as cost_per_portion for all routes)
ALTER TABLE subcontractors ADD COLUMN cost_per_portion_route1 int;

-- Thenie: Route 1 uses our own courier (cheaper), Route 2 Thenie delivers (more expensive)
UPDATE subcontractors SET cost_per_portion_route1 = 19500 WHERE name = 'Thenie';

-- Courier Cash Advance (Kasbon Kurir): current asset, settled against delivery expenses
INSERT INTO accounts (code, name, type, normal_balance, category)
VALUES ('1201', 'Courier Cash Advance', 'Asset', 'Debit', 'Current Assets')
ON CONFLICT (code) DO NOTHING;

-- Allow admins to delete and update journals (previously only service role could write)
CREATE POLICY "owners_delete_journals" ON journals FOR DELETE TO authenticated USING (true);
CREATE POLICY "owners_update_journals" ON journals FOR UPDATE TO authenticated USING (true);
CREATE POLICY "owners_delete_journal_lines" ON journal_lines FOR DELETE TO authenticated USING (true);
CREATE POLICY "owners_insert_journal_lines" ON journal_lines FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "owners_update_journal_lines" ON journal_lines FOR UPDATE TO authenticated USING (true);
