-- Who a bank counterparty is, in the database rather than in somebody's head.
--
-- The statements name individuals. "Aris Wibisono" is Perut Bahagia's owner,
-- "Lizy Tania" sells us plastic, "Yunita Candra Sari" is a courier we employed.
-- None of that is derivable from the line, so every classification pass has to
-- be told — and until now it was told in four places at once: a hardcoded
-- RULES array in `src/lib/accounting/statement-parser.ts`, a prose table in
-- `docs/OPERATIONS.md`, a const map in `scripts/reattribute-kitchens.ts`, and
-- the rest only ever in chat. On 2026-09-14 a pass over the 561 unclassified
-- money-out lines asked the owner to identify nine people he had already
-- identified, because the grouping was rebuilt from the bank strings and none
-- of those four places was consulted. An identity that lives in prose gets
-- re-asked; an identity that lives in a table does not.
--
-- So this is the one place a counterparty is named. `pattern` is a POSIX
-- regular expression matched case-insensitively against the counterparty and
-- the raw description together, `contra_account_code` is where their lines
-- land, and `kind` says why. A row with a null `contra_account_code` is an
-- identity we know and an account we have not decided yet — the ingredient
-- suppliers are exactly that, because the periodic-inventory close they belong
-- to has no inventory or purchases account to land in.
--
-- `priority` orders the match: lower runs first, so a specific person beats a
-- generic merchant pattern. Ties are broken by the longer pattern, because a
-- longer pattern is the more specific one.

CREATE TABLE IF NOT EXISTS bank_counterparties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'kitchen', 'supplier', 'employee', 'courier', 'customer_refund',
    'personal', 'internal', 'platform', 'other'
  )),
  contra_account_code TEXT REFERENCES accounts(code),
  subcontractor_id UUID REFERENCES subcontractors(id),
  bank_account_code TEXT REFERENCES accounts(code),
  notes TEXT,
  priority INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The same name on two statements can mean two things, so a pattern is unique
-- per bank account rather than outright; `bank_account_code` null is "any bank".
CREATE UNIQUE INDEX IF NOT EXISTS bank_counterparties_pattern_bank_idx
  ON bank_counterparties (lower(pattern), COALESCE(bank_account_code, '*'));

CREATE INDEX IF NOT EXISTS bank_counterparties_active_idx
  ON bank_counterparties (is_active, priority);

ALTER TABLE bank_counterparties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins_read_bank_counterparties" ON bank_counterparties
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "admins_write_bank_counterparties" ON bank_counterparties
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- the seed
--
-- Everything the owner has told us, gathered from the four places it was
-- scattered across plus the answers given on 2026-09-14.

INSERT INTO bank_counterparties (pattern, label, kind, contra_account_code, subcontractor_id, priority, notes)
SELECT v.pattern, v.label, v.kind, v.contra, s.id, v.priority, v.notes
FROM (VALUES
  -- Kitchens. The bank name is the owner's; the kitchen is who we are paying.
  ('ANDREAS KURNI|Thenie Catering',      'Andreas Kurnianto — Thenie''s owner',      'kitchen', '2001', 'Thenie',                  10, 'Rp 20.000, Rp 21.000 from 2026-03-29, plus Rp 3.000 ongkir a day from 2026-04-27'),
  ('Santapin Catering|Catering Santapin','Santapin',                                  'kitchen', '2001', 'Santapin',                10, 'Rp 20.000, Rp 19.500 from 2026-02-20'),
  ('ARIS WIBISONO',                      'Aris Wibisono — Perut Bahagia''s owner',    'kitchen', '2001', 'Perut Bahagia',           10, 'Rp 21.000 per portion'),
  ('STEFANO MARIO SUPIT',                'Stefano Mario Supit — Yuk Makan''s owner',  'kitchen', '2001', 'Yuk Makan',               10, 'Rp 23.000, Rp 27.000 for size M'),
  ('FENTI AFRILTIA',                     'Fenti Afriltia — Pangkha''s owner',         'kitchen', '2001', 'Pangkha Catering',        10, 'Rp 21.000 then Rp 23.000'),
  ('ELVINA PUSPITA DEWI',                'Elvina Puspita Dewi — Hanvin Kitchen',      'kitchen', '2001', 'Hanvin Kitchen',          10, 'Rp 22.000 per portion'),
  ('GRACE SINTHIKE',                     'Grace Sinthike Kewas — Cendana Catering',   'kitchen', '2001', 'Cendana Catering',        10, 'Rp 18.000 per portion'),
  ('LILI ANGGRAINI',                     'Lili Anggraini — Catering Bintaro BSD',     'kitchen', '2001', 'Catering Bintaro BSD',    10, NULL),
  ('IKA PURNAMA SARI',                   'Ika Purnama Sari — Molls Kitchen',          'kitchen', '2001', 'Molls Kitchen',           10, 'Cooked Ade Dian''s ICE BSD event, 20 Agustus 2026'),
  ('Family Nusantara Caterin',           'Family Nusantara Catering',                 'kitchen', '2001', 'Family Nusantara Catering', 10, NULL),
  ('LAELA SAKINAH',                      'Laela Sakinah — the Karawaci catering',     'kitchen', '2001', 'Katering Karawaci (nama belum diketahui)', 10, 'Informal, kitchen name still unknown')
) AS v(pattern, label, kind, contra, sub, priority, notes)
LEFT JOIN subcontractors s ON s.name = v.sub
ON CONFLICT DO NOTHING;

INSERT INTO bank_counterparties (pattern, label, kind, contra_account_code, priority, notes) VALUES
  -- Ingredient and packaging suppliers, all from the in-house period. COGS for
  -- that period is periodic — opening inventory plus purchases minus closing,
  -- counted Rp 3.500.000 on 2025-12-14 — and the chart has neither an inventory
  -- asset nor a purchases account, so these carry no contra account yet. They
  -- are identities, not an unanswered question.
  ('LIZY TANIA',           'Lizy Tania — plastic and packaging supplier',  'supplier', NULL,   20, 'In-house period; belongs in the periodic-inventory purchases pool'),
  ('DEWI KANIA LARASAT',   'Dewi Kania Larasati — chicken supplier',       'supplier', NULL,   20, 'In-house period; belongs in the periodic-inventory purchases pool'),
  ('ABDUL HAPIZ PULUNG',   'Abdul Hapiz Pulung — rice supplier',           'supplier', NULL,   20, 'In-house period; belongs in the periodic-inventory purchases pool'),

  -- Staff.
  ('YUNITA CANDRA SARI',   'Yunita Candra Sari — courier we employed',     'courier',  '5002', 20, 'Employee, paid as courier cost like the current courier''s wage'),

  -- Refunds of money a customer had already paid in: the deposit comes back
  -- out of 2100, it is not an expense.
  ('ALVIN MULIA',          'Refund to Kevin Mulia, paid to Alvin Mulia',   'customer_refund', '2100', 15, 'Rp 850.000 on 2026-04-27'),
  ('LAURENCIA ANGELINA',   'Refund — the 75-portion order, late Desember 2025', 'customer_refund', '2100', 15, 'Rp 800.000 on 2025-12-22'),

  -- Delivery bought from outside.
  ('LALAMOVE|GOJEK|GRAB ?BIKE|GRAB ?FOOD|Pembayaran [Kk]e GRAB|DAEVIN THOMAS', 'GrabExpress and other outside couriers', 'courier', '5002', 30, 'Used when a wrong delivery had to be corrected'),
  ('Dnid Sal\w*\s+Put|Dnid Donx Kur',  'Courier cash advance (kasbon)',     'courier',  '1201', 20, NULL),

  -- Infrastructure and the phone.
  ('Pembayaran ke XL|\bXL AXIATA\b',   'XL — the business phone',          'platform', '6003', 30, 'Keeps an old SIM number alive'),
  ('DEEPSEEK|ANTHROPIC|OPENAI|RAILWAY|SUPABASE|VERCEL|ACCURATE ONL|CURSOR USAGE|ESB RESTAURANT', 'Software and infrastructure', 'platform', '6003', 30, NULL),
  ('FACEBK|FACEBOOK|\bMETA PLATFORMS\b', 'Meta ads',                       'platform', '6001', 30, NULL),

  -- Justin''s own money moving through the business account. 2002 is his
  -- current account, so a personal spend is a draw against it, never a cost.
  ('KREDIONE|ADAPUNDI|KREDIFAZZ',      'Personal loan and paylater repayment', 'personal', '2002', 25, 'Borrowed in his own name, repaid from the business account'),
  ('UNIV-NONTUIT',                     'University fee — personal',        'personal', '2002', 25, NULL),
  ('KREDIT UTAMA|INFO TEKNO|Transfer Other Ban', 'Loan proceeds paid in by Justin', 'personal', '2002', 25, 'The business owes him, not a lender'),
  ('FLAZZ|\/DANA\b|TARIKAN ATM|SPBU|SETORAN VIA CDM|ESPAY|RAHMA MAULIDA|PINTR\.ID|BICARAKAN\.ID|DANIEL RAHARDYAN P|Daniel Rahardyan Pramady', 'Justin — personal', 'personal', '2002', 40, NULL),

  -- Money that never left us.
  ('SHOPEEPAY',                        'Our own ShopeePay wallet',         'internal', '1005', 30, NULL),
  ('POKET VALAS|FTMCA',                'Our own BCA valas account',        'internal', '1006', 30, NULL),
  ('AGNESIA',                          'Our own Superbank account',        'internal', '1003', 30, NULL),

  -- Bank mechanics.
  ('BIAYA ADM|PAJAK BUNGA|BIAYA KARTU', 'Bank charges',                    'other',    '6002', 30, NULL),
  ('^BUNGA\b|Bunga Didapat',           'Interest earned',                  'other',    '4900', 30, NULL)
ON CONFLICT DO NOTHING;
