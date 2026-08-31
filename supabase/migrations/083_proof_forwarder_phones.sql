-- Who may forward a delivery photo to the WABA and have it sent on to the
-- customer. Kitchens already could — `handleSubcontractorMessage` matches the
-- sender against `subcontractors.admin_phone` — but an owner photographing a
-- drop themselves had no path: their number is a customer row like any other,
-- so the photo was read as a payment proof and the bot replied to it.
--
-- A phone list, not a role check: `admin_users` is keyed by email and holds no
-- number, and the numbers that do this are personal handsets that change
-- without anyone touching the roster. Comma-separated, international format,
-- edited at /settings.
INSERT INTO settings (key, value, description)
VALUES
  (
    'proof_forwarder_phones',
    '+6281213098656',
    'Nomor WhatsApp (pisahkan dengan koma) yang boleh meneruskan foto bukti pengiriman ke nomor utama. Foto dengan caption nama pelanggan langsung diteruskan ke pelanggan itu. Hanya untuk nomor admin — nomor pelanggan di sini akan melewati bot.'
  )
ON CONFLICT (key) DO NOTHING;
