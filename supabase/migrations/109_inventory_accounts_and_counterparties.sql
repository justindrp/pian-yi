-- Periodic-inventory accounts, and the counterparty identities Justin ruled on
-- 2026-09-14 after being asked to read out all 277 unclassified money-out lines.
--
-- Two accounts first. The in-house period (8 Sep – 19 Des 2025) is costed
-- periodically — COGS = opening + purchases - closing, against the Rp 3.500.000
-- counted on 14 Des — and the chart had neither an inventory asset nor a
-- purchases account, so every ingredient supplier's line had nowhere to land
-- and sat unclassified on purpose. 5003 collects the purchases through the
-- period; 1300 holds what the count says is left at the close.
--
-- Then the identities. They are rows here rather than prose because that is the
-- whole point of this table: the same names had been re-asked four times.

INSERT INTO accounts (code, name, type, normal_balance, category) VALUES
  ('1300', 'Inventory', 'Asset', 'Debit', 'Current Assets'),
  ('5003', 'Purchases - Ingredients & Packaging', 'Expense', 'Debit', 'Cost of Services')
ON CONFLICT (code) DO NOTHING;

-- The three suppliers already named but deliberately left with no account now
-- have one.
UPDATE bank_counterparties SET contra_account_code = '5003', updated_at = NOW()
  WHERE pattern IN ('LIZY TANIA', 'DEWI KANIA LARASAT', 'ABDUL HAPIZ PULUNG');

-- Two patterns that were written against a memo shape the bank does not use.
-- `PAJAK BUNGA` never matched "Pajak atas Bunga", and `GOOGLE\*CHROME` never
-- matched "GOOGLE *CHROME TEM", so three lines stayed unclassified next to a
-- rule that was supposed to cover them.
UPDATE bank_counterparties
   SET pattern = 'BIAYA ADM|PAJAK\s+(ATAS\s+)?BUNGA|BIAYA KARTU', updated_at = NOW()
 WHERE pattern = 'BIAYA ADM|PAJAK BUNGA|BIAYA KARTU';
UPDATE bank_counterparties
   SET pattern = replace(pattern, 'GOOGLE\*CHROME', 'GOOGLE\s*\*\s*CHROME'), updated_at = NOW()
 WHERE pattern LIKE '%GOOGLE\*CHROME%';

INSERT INTO bank_counterparties (pattern, label, kind, contra_account_code, bank_account_code, priority, notes) VALUES
  -- Ingredient and packaging suppliers. Periodic inventory: the purchase is an
  -- expense as it happens and the close moves what is left into 1300.
  ('ANDRE LEO HANSEN', 'Andre Leo Hansen', 'supplier', '5003', NULL, 20, 'Supplier tepung'),
  ('PARLINDUNGAN', 'Parlindungan', 'supplier', '5003', NULL, 20, 'Supplier sayur'),
  ('\bJENNI\b', 'Jenni', 'supplier', '5003', NULL, 20, 'Reimburse belanja bahan yang dia talangi. Bagi hasilnya dibayar dari rekening Jago, bukan dari sini.'),

  -- Staff. There is no wages-payable account, so a wage paid straight from the
  -- bank is expensed on the day it leaves.
  ('JASON HAZAEL GANDASAPUTR', 'Jason Hazael Gandasaputra', 'employee', '6005', NULL, 20, NULL),
  ('DIANA FEBRIANTI', 'Diana Febrianti', 'employee', '6005', NULL, 20, NULL),
  ('FELIX JONATAN KUSUMA', 'Felix Jonatan Kusuma', 'employee', '6005', NULL, 20, NULL),
  ('LACEY JUNELLY', 'Lacey Junelly', 'employee', '6005', NULL, 20, NULL),
  ('KAYLA VALENCIA', 'Kayla Valencia Purwa Tan', 'employee', '6005', NULL, 20, NULL),
  ('GRACIELLA SAPUTRA JAYA', 'Graciella Saputra Jaya', 'employee', '6005', NULL, 20, NULL),
  ('NABILA RIZQI', 'Nabila Rizqi Karunia', 'employee', '6005', NULL, 20, NULL),
  ('JOHAN FILIANG', 'Johan Filiang', 'employee', '6005', NULL, 20, NULL),

  -- Sales commission. Marketing rather than a new account: two lines in ten
  -- months does not earn its own ledger line.
  ('TIMOTHY EMERY HART', 'Timothy Emery Hartanto', 'other', '6001', NULL, 20, 'Komisi penjualan'),
  ('AURELIA CHIARA TED', 'Aurelia Chiara Tediwijaya', 'other', '6001', NULL, 20, 'Komisi penjualan'),

  -- Refunds to customers. 2100 is where their money was sitting.
  ('JESICA AFTIANI', 'Jesica Aftiani', 'customer_refund', '2100', NULL, 15, NULL),
  ('ANGELYN PANG', 'Angelyn Pang', 'customer_refund', '2100', NULL, 15, NULL),
  ('STELLA SAFIRA MARYAM', 'Stella Safira Maryam', 'customer_refund', '2100', NULL, 15, NULL),
  ('MIE LIAN', 'Mie Lian', 'customer_refund', '2100', NULL, 15, 'Pembayar salah satu pelanggan Sep-Des 2025'),

  -- Justin's own spending out of BCA.
  ('KEVIN MANGGALA TJI', 'Kevin Manggala Tjipto', 'personal', '2002', '1002', 25, NULL),
  ('NUR IMLA LUBIS', 'Nur Imla Lubis', 'personal', '2002', '1002', 25, NULL),
  ('GRACE KELLY MEYER', 'Grace Kelly Meyer', 'personal', '2002', '1002', 25, NULL),
  ('TJOE SWAN ING', 'Tjoe Swan Ing', 'personal', '2002', '1002', 25, NULL),

  -- Annie's own spending out of her Superbank. 1003 for Des 2025 - 3 Juli 2026
  -- is ANGELA OCTAVIANI's account, so a personal line there is her current
  -- account, not Justin's.
  ('KLARISA DOMINIC', 'Klarisa Dominic Effendy', 'personal', '2003', '1003', 25, NULL),
  ('ANGELA OCTAVIANA', 'Angela Octaviani (Annie)', 'personal', '2003', '1003', 25, 'Pindahan ke rekeningnya sendiri'),
  ('^Pembayaran ke ', 'Belanja QRIS merchant — Annie', 'personal', '2003', '1003', 60, 'Semua merchant F&B/retail di Superbank Annie adalah pengeluaran pribadinya. Prioritas rendah supaya aturan bernama tetap menang.'),

  -- Two pockets of one account. Tabungan Utama and Saku Catering PianYi both
  -- map to 1003, so the move faces itself and nets to nothing; it is recorded
  -- so the line stops reading as unexplained money leaving.
  ('Pindah Uang ke Catering PianYi|Penarikan Uang dari Catering PianYi', 'Pindah saku Superbank Annie', 'internal', '1003', '1003', 20, 'Saku Catering PianYi adalah kantong kedua di rekening yang sama'),

  -- Second round of rulings, same session.
  ('SIDHARTA MAHALO', 'Sidharta Mahalo', 'supplier', '5003', NULL, 20, 'Supplier bahan'),
  ('TOKO ANEKA', 'Toko Aneka', 'supplier', '5003', NULL, 20, 'Supplier kemasan, dibayar QRIS'),
  ('STEVEN RAHARJA', 'Steven Raharja', 'customer_refund', '2100', NULL, 15, NULL),
  ('\\bJOCELYN\\b', 'Jocelyn', 'employee', '6005', NULL, 20, NULL),
  ('HEXA MITRA', 'Hexa Mitra', 'personal', '2002', '1002', 25, NULL),
  ('KARTU DEBIT CANTINERO', 'Cantinero', 'personal', '2002', '1002', 25, NULL)
ON CONFLICT DO NOTHING;
