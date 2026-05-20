-- Enable RLS on all tables
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE edit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- customers: authenticated admins read-all; service role write-all
CREATE POLICY "admins_read_customers" ON customers
  FOR SELECT TO authenticated USING (true);

-- conversations: authenticated admins read-all; service role write-all
CREATE POLICY "admins_read_conversations" ON conversations
  FOR SELECT TO authenticated USING (true);

-- orders: authenticated admins read-all; service role write-all
CREATE POLICY "admins_read_orders" ON orders
  FOR SELECT TO authenticated USING (true);

-- customer_rate_limits, customer_flags, customer_state: service role only
-- (no user policies = no access for authenticated users)

-- push_subscriptions: authenticated user insert/delete their own row
CREATE POLICY "users_insert_own_push" ON push_subscriptions
  FOR INSERT TO authenticated WITH CHECK (user_email = auth.jwt() ->> 'email');

CREATE POLICY "users_delete_own_push" ON push_subscriptions
  FOR DELETE TO authenticated USING (user_email = auth.jwt() ->> 'email');

CREATE POLICY "users_read_own_push" ON push_subscriptions
  FOR SELECT TO authenticated USING (user_email = auth.jwt() ->> 'email');

-- settings, pricing_tiers, message_templates: authenticated admins read
CREATE POLICY "admins_read_settings" ON settings
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "admins_read_pricing" ON pricing_tiers
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "admins_read_templates" ON message_templates
  FOR SELECT TO authenticated USING (true);

-- processed_messages: service role insert only; authenticated admins read
CREATE POLICY "admins_read_processed_messages" ON processed_messages
  FOR SELECT TO authenticated USING (true);

-- edit_log: service role insert only; authenticated admins read
CREATE POLICY "admins_read_edit_log" ON edit_log
  FOR SELECT TO authenticated USING (true);

-- admin_users: authenticated user can read their own row
CREATE POLICY "users_read_own_admin" ON admin_users
  FOR SELECT TO authenticated USING (email = auth.jwt() ->> 'email');
