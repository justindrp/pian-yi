alter table conversations
add column whatsapp_status text,
add column whatsapp_status_updated_at timestamptz;

alter table conversations
add constraint conversations_whatsapp_status_check
check (
  whatsapp_status is null
  or whatsapp_status in ('sent', 'delivered', 'read', 'failed')
);
