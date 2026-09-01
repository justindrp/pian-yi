-- The bot named "Kak Annie" to customers because the name was written into the
-- system prompt and into two tool descriptions. Annie is not active on the
-- inbox, so every refund and escalation the bot handed off was promised to
-- someone who was never going to answer it — Pane was told on 2026-08-31 that
-- "Kak Annie akan mengurus refundnya sampai selesai", and chased it the next
-- morning. Who the customer is handed to is an operational fact that changes;
-- it does not belong in code.
INSERT INTO settings (key, value, description)
VALUES
  (
    'admin_display_name',
    'Justin',
    'Nama admin yang disebut ke pelanggan waktu bot mengoper ke manusia ("Kak Justin akan bantu"). Ganti kalau yang standby di inbox berganti orang. Kosongkan untuk memakai "tim admin kami" tanpa nama.'
  )
ON CONFLICT (key) DO NOTHING;
