-- The inbox has always subscribed to customer_flags UPDATEs to keep the
-- takeover state live, but the table was never added to the realtime
-- publication (migration 015 added only `conversations`), so that handler never
-- fired. One admin taking over a thread left every other admin's header still
-- showing "Take over" until they reselected the thread.
--
-- The 10s inbox poll now reloads flags too, so this is the fast path, not the
-- only path.
ALTER PUBLICATION supabase_realtime ADD TABLE customer_flags;
