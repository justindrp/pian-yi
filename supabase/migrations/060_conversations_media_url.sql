-- Inbound WhatsApp media used to live only as Meta's `media_id`, which Meta
-- deletes after roughly a week — every image in the inbox eventually became a
-- broken placeholder. The webhook now downloads the bytes at receipt time into
-- the private `chat-media` bucket and records the stored URL here.
--
-- This is a separate column rather than a rewrite of `content` because `content`
-- carries the customer's caption (or the `[Dokumen: name]` label), which the bot
-- reads back as conversation context. The backfill script had no caption to
-- preserve and wrote the URL into `content`; the inbox reads either.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS media_url text;

COMMENT ON COLUMN conversations.media_url IS
  'Supabase Storage URL for inbound WhatsApp media saved at receipt time (chat-media bucket). NULL for older rows, whose media_id may already have expired at Meta.';
