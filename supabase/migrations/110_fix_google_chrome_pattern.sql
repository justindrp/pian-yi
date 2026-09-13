-- The GOOGLE *CHROME pattern fix in migration 109 did not take.
--
-- It matched with `LIKE '%GOOGLE\*CHROME%'`, and backslash is LIKE's own escape
-- character in Postgres, so `\*` matched a literal asterisk and the stored
-- pattern — which contains the backslash — was never found. The statement
-- succeeded and updated nothing, which is the quiet way for a fix to fail.
--
-- Matched on the part with no backslash in it instead. The regex itself gains a
-- `\s*` on each side of the asterisk because BCA writes the memo as
-- "GOOGLE *CHROME TEM", with a space the old pattern did not allow.

UPDATE bank_counterparties
   SET pattern = replace(pattern, 'GOOGLE\*CHROME', 'GOOGLE\s*\*\s*CHROME'),
       updated_at = NOW()
 WHERE pattern LIKE '%CHROME%';
