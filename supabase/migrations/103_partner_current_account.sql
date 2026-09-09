-- Annie's profit share is a draw, and a draw needs an account of its own.
--
-- 143 outbound transfers to "Angela Octaviani" totalling Rp 12.658.400 sit on
-- her Superbank statements between Desember 2025 and 3 Juli 2026, in 108
-- distinct odd amounts. They are not expenses and not reimbursements: she took
-- her 40% share daily, off that day's gross profit (revenue minus that day's
-- subcontractor cost), rather than waiting for a period close. Booking them as
-- cost would understate profit twice — once as an expense, and once again as
-- her share of what was left.
--
-- It cannot go in 2002 Owner Current Account. That account is Justin's, and
-- its balance is the running answer to what the business owes him; putting a
-- second person's draws in it makes the number answer nothing. So 2003 sits
-- beside it with the same shape and the same two-way swing: her draws and her
-- personal card purchases on the business account debit it, money she puts
-- back credits it, and her earned share credits it at period close. A debit
-- balance means she has drawn ahead of what she has earned.
--
-- Deliberately not an expense account and not equity. The share is computed on
-- gross profit, so it is a distribution of profit rather than a cost of making
-- it; and it is settled in cash against a running balance, which is a current
-- account, not a capital one. `GET /api/reports` already splits gross profit
-- 60/40 — this is where the 40 lands in the books.
INSERT INTO accounts (code, name, type, normal_balance, category) VALUES
  ('2003', 'Partner Current Account - Annie', 'Liability', 'Credit', 'Current Liabilities')
ON CONFLICT (code) DO NOTHING;
