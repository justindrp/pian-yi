-- Meta reports why an outbound message failed in the status webhook's errors[],
-- and until now that only reached console.error — so by the time anyone noticed
-- a red "Failed" in the inbox, the code that would explain it was gone with the
-- log retention. Every delivery-proof template sent outside the 24h window has
-- failed since June (296 of them) and the reason was unrecoverable.
alter table conversations
  add column if not exists whatsapp_error jsonb;

comment on column conversations.whatsapp_error is
  'Meta errors[] from the failed status webhook: [{code, title, message}]. Null unless whatsapp_status = failed.';
