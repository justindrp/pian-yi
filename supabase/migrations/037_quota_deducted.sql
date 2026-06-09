alter table daily_deliveries
  add column if not exists quota_deducted boolean not null default false;
