-- Bank statements, their parsed lines, and the account that absorbs the
-- personal half of a mixed account.
--
-- Reconciling July and August 2026 by hand on 2026-09-01 found the ledger
-- and the bank describing two different businesses: Rp 17.267.000 was paid
-- to the kitchen over the two months and account 2001 was never once
-- debited, Agnes's Superbank float moved Rp 16,3jt with account 1003 empty,
-- and every Facebook charge, kasbon and admin fee sat outside the books.
-- None of that was discoverable from inside the app, because the app had
-- never seen a bank statement. Now it stores them.
--
-- BCA 4971805760 is Justin's personal account: catering money, salary,
-- Flazz top-ups, DANA, loan disbursements and their repayments all land in
-- it. Rather than filter the personal lines away on import — which loses a
-- real receipt the moment a filter is wrong, and says nothing when it does —
-- every line is stored and classified, and the personal ones book to 2002
-- Owner Current Account. A Flazz top-up is then a drawing (he owes the
-- business), his salary landing there is a loan to it (the business owes
-- him), and the account's balance is the running answer either way.

-- The chart of accounts had no name for a third of what the statements
-- contain, which is why the money was invisible: Rp 26,9jt moved through
-- ShopeePay, Rp 3,8jt into the USD pocket, Rp 12,9jt arrived as loans Justin
-- took out personally, and none of those had an account to land in. Added
-- here so a bank line can always name its contra account instead of being
-- filed under "other".
--
-- 5002 sits beside 5001 Subcontractor Cost rather than in Operating
-- Expenses: getting the food to the customer is part of delivering the
-- service, not overhead. It carries the courier's wage, a trial courier's
-- wage, and the Lalamove rides bought to cover drops the courier missed.
--
-- 2002 sits between 2001 Accounts Payable and 2100 Unearned Revenue in the
-- liability block. It swings both directions; the natural balance is credit
-- because more often than not he is funding the business, not drawing on it.
-- There is deliberately no Loan Payable account: the Rp 12,9jt that arrived
-- from KREDIT UTAMA, INFO TEKNO and one interbank transfer is money Justin
-- borrowed in his own name and put in. The business owes him, not the
-- lender, so it is a 2002 credit like any other injection. Booking it to a
-- loan account would put a debt on the balance sheet that the business is
-- not party to and cannot be pursued for.
INSERT INTO accounts (code, name, type, normal_balance, category) VALUES
  ('1005', 'E-Wallet ShopeePay',    'Asset',     'Debit',  'Current Assets'),
  ('5002', 'Courier & Delivery Cost','Expense',   'Debit',  'Cost of Services'),
  ('1006', 'Bank BCA Valas (USD)',  'Asset',     'Debit',  'Current Assets'),
  ('2002', 'Owner Current Account', 'Liability', 'Credit', 'Current Liabilities'),
  ('4900', 'Other Income',          'Revenue',   'Credit', 'Revenue')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE bank_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which ledger account this statement is the evidence for: 1002 Bank BCA,
  -- 1003 Bank Superbank, 1004 Bank Jago.
  account_code text NOT NULL REFERENCES accounts (code),
  account_number text NOT NULL,
  account_label text,
  -- A BCA e-statement carries an IDR section and a USD "Poket Valas"
  -- section; they are two statements in one PDF and reconcile separately.
  currency text NOT NULL DEFAULT 'IDR',
  period_start date NOT NULL,
  period_end date NOT NULL,
  -- Banks report sen. The ledger is whole rupiah (CLAUDE.md), but rounding a
  -- statement to match it would break the one thing a statement is for: the
  -- control totals it closes on. Stored as it is printed.
  opening_balance numeric(14, 2),
  closing_balance numeric(14, 2),
  total_credit numeric(14, 2),
  total_debit numeric(14, 2),
  credit_count int,
  debit_count int,
  -- 'estatement' is a bank-issued PDF and carries control totals we check
  -- the parse against. 'screenshot' is what you get before the month closes:
  -- an app's transaction list, no totals, possibly a partial window.
  -- 'manual' is typed in.
  source text NOT NULL DEFAULT 'estatement'
    CHECK (source IN ('estatement', 'screenshot', 'manual')),
  file_path text,
  file_type text,
  uploaded_by text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A bank issues one statement per account per period per currency. Uploading
-- the same PDF twice is a mistake; screenshots are exempt because several
-- partial captures of one month are the normal case.
CREATE UNIQUE INDEX idx_bank_statements_unique_estatement
  ON bank_statements (account_number, currency, period_start, period_end)
  WHERE source = 'estatement';

CREATE INDEX idx_bank_statements_period ON bank_statements (period_start, period_end);

CREATE TABLE bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES bank_statements (id) ON DELETE CASCADE,
  -- Position in the statement, so a re-parse of the same file overwrites
  -- rather than duplicates, and so two identical lines on one day stay
  -- distinguishable.
  row_index int NOT NULL,
  txn_date date NOT NULL,
  -- Superbank prints a clock time, BCA does not.
  txn_time text,
  direction text NOT NULL CHECK (direction IN ('CR', 'DB')),
  amount numeric(14, 2) NOT NULL,
  balance_after numeric(14, 2),
  -- The counterparty as the bank spells it, which is not how the customer
  -- spells it: "R BG ANDREAS KURNI" is the kitchen, "Dnid Salxxxxxx Putxx"
  -- is a courier kasbon with the name masked by the sending app.
  counterparty text,
  description text NOT NULL,
  raw_text text,
  -- What the other side of this line is, as an account code. The bank side
  -- is already known — it is the statement's own account_code — so the only
  -- open question about a bank line is which account it faces. A kitchen
  -- payment is 2001, a customer transfer in is 2100, a Flazz top-up is 2002.
  --
  -- This was first written as a closed `category` enum (customer_payment,
  -- kitchen, courier, …) and that is a second chart of accounts standing
  -- beside the real one: every bucket needs a mapping to an account anyway,
  -- the two lists drift, and a bucket with no account is a line that can
  -- never be journalised. Name the account directly.
  --
  -- Null means nobody has decided yet, which is the honest state for an
  -- unrecognised debit and the thing the reconcile queue lists.
  contra_account_code text REFERENCES accounts (code),
  -- The journal this line is the bank-side evidence for. Null means the
  -- money moved and the books do not know it.
  journal_id uuid REFERENCES journals (id) ON DELETE SET NULL,
  matched_at timestamptz,
  matched_by text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_bank_transactions_row ON bank_transactions (statement_id, row_index);
CREATE INDEX idx_bank_transactions_date ON bank_transactions (txn_date);
CREATE INDEX idx_bank_transactions_journal ON bank_transactions (journal_id);
CREATE INDEX idx_bank_transactions_unmatched ON bank_transactions (txn_date)
  WHERE journal_id IS NULL;

ALTER TABLE bank_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins_read_bank_statements" ON bank_statements
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins_read_bank_transactions" ON bank_transactions
  FOR SELECT TO authenticated USING (true);
