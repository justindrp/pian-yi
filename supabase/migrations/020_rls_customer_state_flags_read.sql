-- Allow authenticated admins to read customer_state and customer_flags
-- These were service-role-only but the inbox dashboard needs to display
-- menu_shown status and escalated_to_human flag via the browser client.
CREATE POLICY "admins_read_customer_state" ON customer_state
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "admins_read_customer_flags" ON customer_flags
  FOR SELECT TO authenticated USING (true);
