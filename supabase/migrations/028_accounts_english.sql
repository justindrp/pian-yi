-- Rename accounts and categories to English
UPDATE accounts SET name = 'Cash',                       category = 'Current Assets'       WHERE code = '1001';
UPDATE accounts SET name = 'Bank BCA',                   category = 'Current Assets'       WHERE code = '1002';
UPDATE accounts SET name = 'Bank Superbank',             category = 'Current Assets'       WHERE code = '1003';
UPDATE accounts SET name = 'Bank Jago',                  category = 'Current Assets'       WHERE code = '1004';
UPDATE accounts SET name = 'Accounts Receivable',        category = 'Current Assets'       WHERE code = '1100';
UPDATE accounts SET name = 'Subcontractor Advance',      category = 'Current Assets'       WHERE code = '1200';
UPDATE accounts SET name = 'Accounts Payable',           category = 'Current Liabilities'  WHERE code = '2001';
UPDATE accounts SET name = 'Unearned Revenue',           category = 'Current Liabilities'  WHERE code = '2100';
UPDATE accounts SET name = 'Owner''s Equity',            category = 'Equity'               WHERE code = '3001';
UPDATE accounts SET name = 'Retained Earnings',          category = 'Equity'               WHERE code = '3900';
UPDATE accounts SET name = 'Catering Revenue',           category = 'Revenue'              WHERE code = '4001';
UPDATE accounts SET name = 'Subcontractor Cost',         category = 'Cost of Services'     WHERE code = '5001';
UPDATE accounts SET name = 'Marketing Expense',          category = 'Operating Expenses'   WHERE code = '6001';
UPDATE accounts SET name = 'Administrative Expense',     category = 'Operating Expenses'   WHERE code = '6002';
UPDATE accounts SET name = 'Telephone/Internet Expense', category = 'Operating Expenses'   WHERE code = '6003';
UPDATE accounts SET name = 'Other Expenses',             category = 'Operating Expenses'   WHERE code = '6004';
