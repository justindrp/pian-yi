-- Inbox thread list: one row per customer, holding that customer's newest
-- message.
--
-- The inbox previously fetched the newest 500 conversations rows and grouped
-- them by customer in the browser. With 4.5k+ messages that window only
-- reached customers active in the last few weeks — every lapsed customer was
-- invisible, and the search box (which filters already-loaded rows) could
-- never find them.
--
-- A regular view, not a materialized one: messages arrive continuously and are
-- read occasionally, so a matview would pay a full refresh per inbound message
-- to serve a handful of page loads, and would show a stale inbox whenever the
-- refresh lagged or its trigger broke.

-- DISTINCT ON walks this index and takes the first row per customer instead of
-- sorting the whole table.
CREATE INDEX IF NOT EXISTS conversations_customer_created_idx
  ON conversations (customer_id, created_at DESC);

CREATE OR REPLACE VIEW inbox_threads
WITH (security_invoker = on) AS
SELECT DISTINCT ON (c.customer_id)
  c.id,
  c.customer_id,
  c.role,
  c.content,
  c.message_id,
  c.model_used,
  c.created_at,
  c.intent,
  c.message_type,
  c.media_id,
  c.whatsapp_status,
  c.whatsapp_status_updated_at
FROM conversations c
WHERE c.customer_id IS NOT NULL
ORDER BY c.customer_id, c.created_at DESC;

-- security_invoker means the querying user's RLS applies, so this inherits
-- "admins_read_conversations" from 007_rls.sql rather than bypassing it.
GRANT SELECT ON inbox_threads TO authenticated;

COMMENT ON VIEW inbox_threads IS
  'One row per customer: their most recent conversations row. Backs the admin inbox thread list. Recomputed per query — do not convert to a materialized view, the inbox must never show stale threads.';
