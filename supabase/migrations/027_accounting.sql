-- Accounting: chart of accounts, journal headers, and journal lines

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  type text NOT NULL,           -- Asset, Liability, Equity, Revenue, Expense
  normal_balance text NOT NULL, -- Debit, Credit
  category text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_accounts_code ON accounts (code);

CREATE TABLE journal_sequences (
  year int PRIMARY KEY,
  last_seq int NOT NULL DEFAULT 0
);

CREATE TABLE journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text UNIQUE NOT NULL,
  description text NOT NULL,
  date date NOT NULL,
  source_type text,  -- 'order_payment' | 'delivery'
  source_id uuid,    -- order_id or daily_delivery_id
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_journals_date ON journals (date);
CREATE INDEX idx_journals_source ON journals (source_type, source_id);

CREATE TABLE journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id uuid NOT NULL REFERENCES journals (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id),
  debit int NOT NULL DEFAULT 0,
  credit int NOT NULL DEFAULT 0
);

CREATE INDEX idx_journal_lines_journal_id ON journal_lines (journal_id);
CREATE INDEX idx_journal_lines_account_id ON journal_lines (account_id);

-- Atomic reference generation: JV-YYYY-NNN
CREATE OR REPLACE FUNCTION next_journal_reference(p_year int)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_seq int;
BEGIN
  INSERT INTO journal_sequences (year, last_seq)
  VALUES (p_year, 1)
  ON CONFLICT (year) DO UPDATE
    SET last_seq = journal_sequences.last_seq + 1
  RETURNING last_seq INTO v_seq;
  RETURN 'JV-' || p_year || '-' || LPAD(v_seq::text, 3, '0');
END;
$$;

-- RLS: service role (admin client) bypasses; authenticated users can only read
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins_read_accounts" ON accounts FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins_read_journals" ON journals FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins_read_journal_lines" ON journal_lines FOR SELECT TO authenticated USING (true);

-- Seed chart of accounts
INSERT INTO accounts (code, name, type, normal_balance, category) VALUES
  ('1001', 'Cash',                        'Asset',     'Debit',  'Current Assets'),
  ('1002', 'Bank BCA',                    'Asset',     'Debit',  'Current Assets'),
  ('1003', 'Bank Superbank',              'Asset',     'Debit',  'Current Assets'),
  ('1004', 'Bank Jago',                   'Asset',     'Debit',  'Current Assets'),
  ('1100', 'Accounts Receivable',         'Asset',     'Debit',  'Current Assets'),
  ('1200', 'Subcontractor Advance',       'Asset',     'Debit',  'Current Assets'),
  ('2001', 'Accounts Payable',            'Liability', 'Credit', 'Current Liabilities'),
  ('2100', 'Unearned Revenue',            'Liability', 'Credit', 'Current Liabilities'),
  ('3001', 'Owner''s Equity',             'Equity',    'Credit', 'Equity'),
  ('3900', 'Retained Earnings',           'Equity',    'Credit', 'Equity'),
  ('4001', 'Catering Revenue',            'Revenue',   'Credit', 'Revenue'),
  ('5001', 'Subcontractor Cost',          'Expense',   'Debit',  'Cost of Services'),
  ('6001', 'Marketing Expense',           'Expense',   'Debit',  'Operating Expenses'),
  ('6002', 'Administrative Expense',      'Expense',   'Debit',  'Operating Expenses'),
  ('6003', 'Telephone/Internet Expense',  'Expense',   'Debit',  'Operating Expenses'),
  ('6004', 'Other Expenses',              'Expense',   'Debit',  'Operating Expenses');
