-- 6005 Salaries & Wages.
--
-- The chart had no name for staff pay, so the two BCA transfers that paid
-- Agnes her salary — 1.586.000 on 12 Agustus and 156.000 on 17 Agustus, the
-- day she resigned — were coded 1003 Bank Superbank on import. A reasonable
-- guess: she is also the person whose Superbank account the kitchen float ran
-- through, and every other transfer bearing her name was that float.
--
-- Reconciling August proved the guess wrong. Her Superbank closes on
-- 2026-08-17 with the balance swept back to BCA, and the chain ties to the
-- sen without those transfers: 673.009,37 carried in from July, plus
-- 6.000.000 of float, less 5.681.000 paid out, is exactly the 992.009 that
-- returns. Money coded as arriving in an account it demonstrably never
-- entered is not a rounding question — 1003 was overstated by Rp 1.742.000
-- and wages were understated by the same.
--
-- 6005 sits in Operating Expenses rather than beside 5002 Courier &
-- Delivery Cost in Cost of Services: the courier's wage is per delivery and
-- scales with the food, an admin salary is paid whether or not anyone
-- orders.
--
-- Only Justin, Annie and Friska remain and none of them draws a salary
-- through this account, so the account is expected to sit still after
-- August. It exists because the history needs somewhere true to live.
INSERT INTO accounts (code, name, type, normal_balance, category) VALUES
  ('6005', 'Salaries & Wages', 'Expense', 'Debit', 'Operating Expenses')
ON CONFLICT (code) DO NOTHING;
