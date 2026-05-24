-- Enable realtime for conversations table
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;

-- Add missing UPDATE policy for push_subscriptions so upsert works
CREATE POLICY "users_update_own_push" ON push_subscriptions
  FOR UPDATE TO authenticated
  USING (user_email = auth.jwt() ->> 'email')
  WITH CHECK (user_email = auth.jwt() ->> 'email');
