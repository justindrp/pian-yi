-- Who typed it. `conversations` recorded that a human wrote a message
-- (`model_used = 'human'`) but never which one, so every hand-typed reply to a
-- customer was anonymous — including the ones sent from the inbox by an admin
-- who is not allowed to hand-type at all. Nothing else in the row identifies
-- the sender: role is 'assistant' for the bot and the human alike.
--
-- Null on every historical row and on everything the bot sends. It is only set
-- where a person composed the text: the inbox manual reply/image/document
-- paths, the dashboard's WhatsApp send, and the admin-guided bot reply (the
-- admin chose to send it, so they own it).
alter table conversations
  add column if not exists sent_by text;

comment on column conversations.sent_by is
  'Email of the admin who composed this outbound message. Null for bot replies, system messages, inbound customer messages, and every row written before 2026-08-21.';

create index if not exists conversations_sent_by_idx
  on conversations (sent_by)
  where sent_by is not null;
