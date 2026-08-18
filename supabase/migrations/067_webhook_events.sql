-- Durable landing table for raw WhatsApp webhook payloads.
--
-- The webhook returns 200 to Meta and *then* processes. That is deliberate
-- (Meta's timeout is short and processing calls the model), but it means a
-- database outage silently eats customer messages: the 200 has already gone
-- out, so Meta never retries, and the message is gone with no record that it
-- ever arrived. The 2026-08-18 Supabase REST outage would have done exactly
-- that had anyone written in during those 15 minutes.
--
-- The payload is now written here before the 200 is sent. If that write fails
-- the route returns 500 instead, which is what makes Meta retry. The stored
-- payload is also the replay source when processing itself fails.
create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  -- Meta's own id for the message or status this payload carries. Unique so a
  -- Meta retry lands on the existing row instead of duplicating it; null for
  -- payloads we cannot key (those are stored anyway, never dropped).
  event_key text unique,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  -- Null while queued or in flight; set when processing finished cleanly.
  processed_at timestamptz,
  -- Last failure, kept so a stuck event is findable. Cleared on success.
  error text
);

-- The operational query is "what came in that never finished processing".
create index if not exists webhook_events_unprocessed_idx
  on public.webhook_events (received_at)
  where processed_at is null;

alter table public.webhook_events enable row level security;

-- Server-only, same as processed_messages: written by the webhook via the
-- service role, never read by a browser client.
create policy "service role manages webhook_events"
  on public.webhook_events for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
