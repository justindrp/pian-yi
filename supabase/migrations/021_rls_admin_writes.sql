-- Allow authenticated admins to write to dashboard-managed tables.
-- System-internal tables (customer_rate_limits, customer_flags, customer_state,
-- conversations, processed_messages, edit_log) remain service-role-only.

CREATE POLICY "admins_write_customers" ON customers
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "admins_write_orders" ON orders
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "admins_write_settings" ON settings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "admins_write_pricing" ON pricing_tiers
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "admins_write_templates" ON message_templates
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
