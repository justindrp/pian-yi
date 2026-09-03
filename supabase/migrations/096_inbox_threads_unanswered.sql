-- One boolean instead of two, so the "Unanswered" tab is a single .eq() filter.
--
-- The tab used to filter rows the browser had already loaded. Once the thread
-- list is paged with .range() that is wrong — it would show only the unanswered
-- threads inside the current page — so the filter has to run in the database.
-- Expressed as two columns it needs `or=(escalated_to_human.eq.true,
-- pending_bot_response.eq.true)`, and PostgREST cannot AND that against the
-- search box's own or=(...) in one request. A derived column composes.
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
  COALESCE(cf.pending_bot_response, false) AS pending_bot_response,
  COALESCE(cf.escalated_to_human, false)
    OR COALESCE(cf.pending_bot_response, false) AS unanswered
FROM conversations c
JOIN customers cust ON cust.id = c.customer_id
LEFT JOIN customer_state cs ON cs.customer_id = c.customer_id
LEFT JOIN customer_flags cf ON cf.customer_id = c.customer_id
WHERE c.customer_id IS NOT NULL
ORDER BY c.customer_id, c.created_at DESC;

GRANT SELECT ON inbox_threads TO authenticated;
