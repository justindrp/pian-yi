-- Migration 113: the fourth pass over the unclassified money-out lines.
--
-- Justin ruled another nineteen counterparties. Most are ordinary rows in
-- `bank_counterparties`. Three are not, and the reasons are worth keeping:
--
--   1. Nany Widjaya is the owner of a kitchen we used once, in Desember 2025,
--      and which was never entered anywhere. A `kitchen` counterparty row
--      needs a `subcontractor_id`, so the subcontractor has to exist first.
--      Her nickname is a placeholder — customers never saw this kitchen, and
--      the naming convention (plants) is the only thing it has to obey.
--
--   2. Glady Calista and Lyh Novita Catrina each appear on BOTH sides of the
--      statement. `bank_counterparties` says who a person is, not what a
--      direction means, so a rule naming Glady an employee would also rewrite
--      her Rp 135.000 catering payment from 2100 to 6005 on the next import.
--      Both are one-off Desember/November lines, so they are written by
--      transaction id with `matched_by` set, which is what stops a re-import
--      touching them. Do not "tidy" these into patterns.
--
--   3. The Rp 1.354.000 GoPay line of 6 November is a refund to a customer,
--      but all eleven GoPay lines carry the identical text "70027/GoPay
--      Transf" — there is nothing to match on. Same treatment: by id.

INSERT INTO subcontractors (name, customer_nickname, is_active, cost_per_portion, delivery_areas, delivery_days, notes)
VALUES (
  'Cahaya 99',
  'Dapur Kenanga',
  FALSE,
  0,
  '{}',
  '{1,2,3,4,5,6}',
  'Dipakai sekali, Desember 2025. Pemilik: Nany Widjaya. Nickname sementara.'
)
ON CONFLICT DO NOTHING;

INSERT INTO bank_counterparties (pattern, label, kind, contra_account_code, subcontractor_id, bank_account_code, priority, notes) VALUES
  ('Nany Widjaya', 'Nany Widjaya — Cahaya 99''s owner', 'kitchen', '2001',
   (SELECT id FROM subcontractors WHERE name = 'Cahaya 99'), NULL, 10, NULL),

  -- Customer refunds. These names sit on credits too, and a credit from them
  -- is already 2100, so one account serves both directions.
  ('Dylan Valerian',    'Dylan Valerian',   'customer_refund', '2100', NULL, NULL, 15, NULL),
  ('CHRISTOPHER TANPUY','Christopher Tanpuy','customer_refund','2100', NULL, NULL, 15, NULL),
  ('\bShella\b',        'Shella',           'customer_refund', '2100', NULL, NULL, 15, NULL),
  ('Venny Teora',       'Venny Teora',      'customer_refund', '2100', NULL, NULL, 15, 'Pembayar untuk pelanggan Vivi'),
  ('Lymuryati',         'Lymuryati',        'customer_refund', '2100', NULL, NULL, 15, 'Pembayar untuk salah satu pelanggan'),

  ('MUHAMAD DIVA', 'Muhamad Diva — kurir', 'courier', '5002', NULL, NULL, 20, NULL),
  ('TURISNO',      'Turisno — supplier ayam', 'supplier', '5003', NULL, NULL, 20, NULL),

  ('Marsya Adhenia',    'Marsya Adhenia',    'employee', '6005', NULL, NULL, 20, NULL),
  ('Ferdy Silananda',   'Ferdy Silananda',   'employee', '6005', NULL, NULL, 20, NULL),
  ('Phoebe Lunneta',    'Phoebe Lunneta',    'employee', '6005', NULL, NULL, 20, NULL),
  ('Vincent Salim',     'Vincent Salim',     'employee', '6005', NULL, NULL, 20, 'Bukan Vincent Pinnadi Lo'),
  ('Joycelyn Anglico',  'Joycelyn Anglico',  'employee', '6005', NULL, NULL, 20, 'Bukan Jocelyn'),
  ('Geraldy Kurniawan', 'Geraldy Kurniawan', 'employee', '6005', NULL, NULL, 20, NULL),
  ('Hazel Neal',        'Hazel Neal',        'employee', '6005', NULL, NULL, 20, NULL),
  ('Dnid Rezx',         'Dnid Rezx Fah… — karyawan', 'employee', '6005', NULL, NULL, 20, NULL),

  -- Annie's own spending out of her Superbank: 2003, pinned to 1003, exactly
  -- like the QRIS catch-all. Unpinned it would outrank that rule elsewhere.
  ('SHIRO MILK', 'Shiro Milk — belanja Annie', 'personal', '2003', NULL, '1003', 25, NULL),

  ('KOREKSI BUNGA', 'Interest correction', 'other', '4900', NULL, NULL, 30, 'Koreksi bunga bank, lawan dari rule bunga')
ON CONFLICT DO NOTHING;

-- The three lines that cannot be a pattern. `matched_by` is what a re-import
-- checks before rewriting a contra account, so it has to be set here.
UPDATE bank_transactions
   SET contra_account_code = '6005', matched_at = NOW(), matched_by = 'system:migration-113'
 WHERE id = 'ea29cec8-f6b7-4f28-924a-fc0d6bef7c38';  -- Glady Calista, Rp 27.000, 24 Des 2025

UPDATE bank_transactions
   SET contra_account_code = '2002', matched_at = NOW(), matched_by = 'system:migration-113'
 WHERE id = 'ffe151ef-f871-434b-b29e-cdd398a3aa22';  -- Lyh Novita Catrina, Rp 23.000, 5 Nov 2025

UPDATE bank_transactions
   SET contra_account_code = '2100', matched_at = NOW(), matched_by = 'system:migration-113'
 WHERE id = '242643a4-8f55-4b0f-8d5d-a799837d72c5';  -- GoPay Rp 1.354.000, refund ke Gita, 6 Nov 2025
