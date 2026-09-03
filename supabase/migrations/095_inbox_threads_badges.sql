-- The inbox thread list drew one row from four queries: inbox_threads, the
-- whole customers table, then customer_state and customer_flags keyed by an
-- .in() of every customer id. Four round-trips, ~85 KB gzipped, re-run on
-- every refresh — the bulk of what put the project over its 5 GB egress quota
-- (see "The inbox refresh" in docs/ADMIN.md).
--
-- Everything the list renders now comes off this view, so a refresh is one
-- query and can be paged with .range() and searched in the database.
--
-- customer_state and customer_flags are both PRIMARY KEY (customer_id), so the
-- joins cannot multiply rows and DISTINCT ON still returns one row per
-- customer. LEFT JOIN because a customer may have neither row yet: an inbound
-- message creates the customer before anything writes state or flags, and an
-- INNER JOIN would drop that brand-new thread out of the inbox.
--
-- Columns are appended at the end, and the existing list is unchanged:
-- CREATE OR REPLACE VIEW can only add columns at the end, and renaming one in
-- place fails with "cannot change name of view column" (42P16).
CREATE OR REPLACE VIEW inbox_threads
WITH (security_invoker = on) AS
SELECT DISTINCT ON (c.customer_id)
  c.id, c.customer_id, c.role, c.content, c.message_id, c.model_used,
  c.created_at, c.intent, c.message_type, c.media_id,
  c.whatsapp_status, c.whatsapp_status_updated_at, c.media_url,
  cust.name AS customer_name,
  cust.phone_number AS customer_phone,
  COALESCE(cs.menu_shown, false) AS menu_shown,
  COALESCE(cf.escalated_to_human, false) AS escalated_to_human,
  COALESCE(cf.pending_bot_response, false) AS pending_bot_response
FROM conversations c
JOIN customers cust ON cust.id = c.customer_id
LEFT JOIN customer_state cs ON cs.customer_id = c.customer_id
LEFT JOIN customer_flags cf ON cf.customer_id = c.customer_id
WHERE c.customer_id IS NOT NULL
ORDER BY c.customer_id, c.created_at DESC;

GRANT SELECT ON inbox_threads TO authenticated;

COMMENT ON VIEW inbox_threads IS
  'One row per customer: their most recent conversations row, plus the name, phone and badge flags the admin inbox thread list renders. Backs that list as a single paged query. Recomputed per query — do not convert to a materialized view, the inbox must never show stale threads.';
