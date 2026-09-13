-- The BCA merchant lines, read out to Justin one by one and ruled on.
--
-- The date tells most of the story. Sep–Des 2025 is the in-house period, when
-- we cooked ourselves and bought our own ingredients, so a QRIS payment to a
-- market stall or a plastic shop then is stock. From April 2026 the kitchens
-- cook, so a QRIS payment to a bubble tea shop is Justin's lunch.
--
-- Every personal rule here is pinned to `1002`. Some of these merchants also
-- appear on Annie's Superbank, where they are her spending (2003) and are
-- already caught by the `^Pembayaran ke ` rule scoped to 1003 — an unpinned
-- 2002 rule would outrank it and then be rewritten to 1002 by `classify()`,
-- which is how a personal expense turns into a phantom bank transfer.

INSERT INTO bank_counterparties (pattern, label, kind, contra_account_code, bank_account_code, priority, notes) VALUES
  -- Ingredients and packaging bought during the in-house period.
  ('ANGKASA', 'Angkasa Plastik (Lizy Tania)', 'supplier', '5003', NULL, 20, 'Toko milik Lizy Tania — Angkasa nama tokonya, Lizy pemiliknya. Bahan dan kemasan.'),
  ('SAYUR KITA', 'Sayur Kita', 'supplier', '5003', NULL, 20, 'Bahan'),
  ('PS 8_BUMBU|PS 8 - ROS', 'PS 8', 'supplier', '5003', NULL, 20, 'Bahan'),
  ('TOKO ANEKA', 'Toko Aneka', 'supplier', '5003', NULL, 20, 'Bahan'),
  ('1013-HERO', 'Hero', 'supplier', '5003', NULL, 20, 'Bahan. Pola dipatok ke kode gerai karena "HERO" sendiri ikut kena nama orang di baris lain.'),

  -- Kertas A4 untuk mencetak selebaran Pian Yi.
  ('MULTI GUNA', 'Multi Guna', 'other', '6001', NULL, 20, 'Kertas A4 untuk cetak flyer'),

  -- Justin's own spending on BCA.
  ('Rebis Kitc', 'Rebis Kitchen', 'personal', '2002', '1002', 25, NULL),
  ('Daiichi Su', 'Daiichi', 'personal', '2002', '1002', 25, NULL),
  ('fuwitymix', 'Fuwitymix', 'personal', '2002', '1002', 25, NULL),
  ('AUNTIE ANN', 'Auntie Anne''s', 'personal', '2002', '1002', 25, NULL),
  ('CHATIME', 'Chatime', 'personal', '2002', '1002', 25, NULL),
  ('MATCHA Sto', 'Matcha Store', 'personal', '2002', '1002', 25, NULL),
  ('AMBROSIA', 'Ambrosia', 'personal', '2002', '1002', 25, NULL),
  ('FIVE GRAMS', 'Five Grams', 'personal', '2002', '1002', 25, NULL),
  ('EasyEat', 'EasyEat', 'personal', '2002', '1002', 25, NULL),
  ('Teazzi', 'Teazzi', 'personal', '2002', '1002', 25, NULL),
  ('MALA KITCH', 'Mala Kitchen', 'personal', '2002', '1002', 25, 'Pola menyertakan "KITCH" karena "MALA" sendiri kena nama pelanggan.'),
  ('ES OYEN DU', 'Es Oyen', 'personal', '2002', '1002', 25, NULL),
  ('Martabak L', 'Martabak', 'personal', '2002', '1002', 25, NULL),
  ('Bakmie Bul', 'Bakmie Bule', 'personal', '2002', '1002', 25, NULL),
  ('MILLIONS', 'Millions', 'personal', '2002', '1002', 25, NULL),
  ('VJ FAMILY', 'VJ Family', 'personal', '2002', '1002', 25, NULL),
  ('WJB SURATN', 'WJB Suratna', 'personal', '2002', '1002', 25, NULL),
  ('PUSDIK TEN', 'Pusdik', 'personal', '2002', '1002', 25, NULL),
  ('APOTEK KAW', 'Apotek Kawan', 'personal', '2002', '1002', 25, NULL),
  ('IDM INDOMA', 'Indomaret', 'personal', '2002', '1002', 25, NULL)
ON CONFLICT DO NOTHING;

UPDATE bank_counterparties
   SET notes = 'Bahan dan kemasan. Bayar QRIS lewat tokonya, Angkasa Plastik.',
       updated_at = NOW()
 WHERE pattern = 'LIZY TANIA';
