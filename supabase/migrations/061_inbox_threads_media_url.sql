-- Keep inbox_threads in step with conversations: the thread list renders the
-- newest message, so it needs the stored-media URL added in migration 060.
-- Column list is explicit (not SELECT *) so a view replace stays a deliberate act.
-- media_url is appended last, not slotted next to media_id: CREATE OR REPLACE
-- can only add columns at the end, and renaming an existing position fails with
-- "cannot change name of view column" (42P16).
CREATE OR REPLACE VIEW inbox_threads
WITH (security_invoker = on) AS
SELECT DISTINCT ON (c.customer_id)
  c.id, c.customer_id, c.role, c.content, c.message_id, c.model_used,
  c.created_at, c.intent, c.message_type, c.media_id,
  c.whatsapp_status, c.whatsapp_status_updated_at, c.media_url
FROM conversations c
WHERE c.customer_id IS NOT NULL
ORDER BY c.customer_id, c.created_at DESC;

GRANT SELECT ON inbox_threads TO authenticated;
