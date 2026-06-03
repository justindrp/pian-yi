alter table customer_flags
  add column if not exists pending_bot_response boolean not null default false,
  add column if not exists pending_bot_question text;
