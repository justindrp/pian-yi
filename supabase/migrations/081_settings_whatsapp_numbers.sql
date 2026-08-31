-- The two WhatsApp numbers the business runs on lived only in docs/WHATSAPP.md,
-- so every session that needed one either grepped for it or re-derived it from
-- an old transcript. They are operational facts, not code: put them where the
-- rest of the operational facts live.
--
-- The manual number is deliberately NOT read by src/lib/claude/prompts/system.ts.
-- It is hand-operated, nothing it sends reaches `conversations`, and a bot that
-- could quote it would be handing customers a channel with none of the API
-- path's guards. See "The manual number" in docs/WHATSAPP.md.
INSERT INTO settings (key, value, description)
VALUES
  (
    'whatsapp_business_number',
    '+6285111214390',
    'Nomor WhatsApp utama (WABA) — nomor yang dipakai aplikasi untuk kirim/terima pesan. Pelanggan harus chat ke sini supaya window 24 jam terbuka.'
  ),
  (
    'whatsapp_manual_number',
    '+6285128024390',
    'Nomor WhatsApp kedua, dioperasikan manual (bukan API). Dipakai hanya untuk menjangkau pelanggan yang window-nya sudah tertutup. Jangan pernah dikutip ke pelanggan sebagai kontak umum dan jangan pernah masuk ke prompt bot.'
  )
ON CONFLICT (key) DO NOTHING;
