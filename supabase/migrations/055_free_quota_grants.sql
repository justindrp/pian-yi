alter table orders
  add column source text not null default 'purchase' check (source in ('purchase', 'free_quota')),
  add column grant_reason text,
  add column granted_by text;
