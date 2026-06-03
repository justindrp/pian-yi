create table broadcasts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by text not null,
  instruction text not null,
  message_template text not null,
  filter jsonb not null default '{}',
  recipient_count int not null default 0,
  status text not null default 'sent',
  constraint broadcasts_status_check check (status in ('sent', 'failed'))
);

create table broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references broadcasts(id) on delete cascade,
  customer_id uuid not null references customers(id),
  phone_number text not null,
  personalized_message text not null,
  status text not null default 'sent',
  error text,
  sent_at timestamptz,
  constraint broadcast_recipients_status_check check (status in ('sent', 'failed'))
);

create index broadcasts_created_at_idx on broadcasts(created_at desc);
create index broadcast_recipients_broadcast_id_idx on broadcast_recipients(broadcast_id);

alter table broadcasts enable row level security;
alter table broadcast_recipients enable row level security;

create policy "Authenticated users can manage broadcasts"
  on broadcasts for all to authenticated using (true) with check (true);

create policy "Authenticated users can manage broadcast_recipients"
  on broadcast_recipients for all to authenticated using (true) with check (true);
