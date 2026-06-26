-- Persistent chat history for the dashboard Admin Assistant (shared across all admins)
create table assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references assistant_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index assistant_messages_conv_created_idx on assistant_messages(conversation_id, created_at);
create index assistant_conversations_updated_idx on assistant_conversations(updated_at desc);

-- Enable RLS; service-role admin client bypasses it for API writes.
-- Permissive policy keeps the table readable to any authenticated dashboard user (shared scope).
alter table assistant_conversations enable row level security;
alter table assistant_messages enable row level security;

create policy "authenticated read assistant_conversations" on assistant_conversations
  for select to authenticated using (true);
create policy "authenticated write assistant_conversations" on assistant_conversations
  for all to authenticated using (true) with check (true);

create policy "authenticated read assistant_messages" on assistant_messages
  for select to authenticated using (true);
create policy "authenticated write assistant_messages" on assistant_messages
  for all to authenticated using (true) with check (true);
