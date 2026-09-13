-- Two corrections to migration 109.
--
-- The Jocelyn pattern was written through a shell heredoc and arrived with its
-- backslashes doubled — `\\bJOCELYN\\b`, which as a regex is a literal
-- backslash followed by a word boundary, so it matched nothing and her two
-- lines stayed unclassified next to a rule that named her.
--
-- And "QR MITRA ANEKA" is the merchant BCA truncates to "MITRA ANEK", not the
-- separate "TOKO ANEKA" the first pass guessed at. Toko Aneka has never been
-- ruled on, so its rule comes out and its one line goes back to unclassified
-- rather than being left in an account nobody chose.

UPDATE bank_counterparties SET pattern = '\bJOCELYN\b', updated_at = NOW()
 WHERE label = 'Jocelyn';

DELETE FROM bank_counterparties WHERE pattern = 'TOKO ANEKA';

UPDATE bank_transactions SET contra_account_code = NULL
 WHERE contra_account_code = '5003'
   AND description ILIKE '%TOKO ANEKA%'
   AND matched_by IS NULL;

INSERT INTO bank_counterparties (pattern, label, kind, contra_account_code, priority, notes) VALUES
  ('MITRA ANEK', 'Mitra Aneka', 'supplier', '5003', 20, 'Supplier kemasan, dibayar QRIS')
ON CONFLICT DO NOTHING;
