-- One row per customer who has ever sent us a message, carrying the timestamp
-- of their most recent inbound. `scripts/review-chats.ts` picked the threads
-- for a 24h review by paging every inbound `conversations` row in the window,
-- 1000 at a time, and deduplicating to customer ids in JavaScript — O(messages)
-- transferred to learn O(customers). Today that is 30 rows and the busiest day
-- on record is 129, so this is a scalability fix, not a speed one: thread count
-- is bounded by how many customers write in a day, message count is not.
--
-- "Had an inbound since X" is the same question as "their newest inbound is at
-- or after X", so the window stays a parameter on this side of the view and the
-- view itself needs none.
--
-- Not `inbox_threads`, which is the last message per customer whatever its
-- role. The 08:00 keep-alive cron writes outbound to ~10 threads at once, so
-- keying a review off that view would pull in every thread it pinged even when
-- the customer never answered. A review reads threads someone is waiting on.
--
-- DISTINCT ON over the (customer_id, created_at DESC) index migration 059 added
-- for inbox_threads, so no new index.
--
-- No GRANT: the only reader is a script on the service role, which does not need
-- one. Leaving it ungranted keeps the view off the anon and authenticated APIs.
CREATE OR REPLACE VIEW review_inbound_threads
WITH (security_invoker = on) AS
SELECT DISTINCT ON (c.customer_id)
  c.customer_id,
  c.created_at AS last_inbound_at
FROM conversations c
WHERE c.customer_id IS NOT NULL
  AND c.role = 'user'
ORDER BY c.customer_id, c.created_at DESC;
