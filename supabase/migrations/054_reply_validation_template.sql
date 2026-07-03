INSERT INTO message_templates (key, template, description) VALUES
  ('reply_validation_fallback', 'Bentar ya kak, aku cek dulu sama admin 🙏', 'Sent when the reply validator rejects a bot reply twice in a row (possible hallucinated customer-specific fact)')
ON CONFLICT (key) DO NOTHING;
