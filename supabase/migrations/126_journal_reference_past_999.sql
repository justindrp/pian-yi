-- The journal reference silently capped the ledger at 999 entries per year.
--
-- `next_journal_reference()` rendered the sequence with LPAD(v_seq::text, 3, '0'),
-- and Postgres LPAD *truncates* when the input is longer than the target length:
-- LPAD('1000', 3, '0') is '100', not '1000'. So the 1000th journal of a year asked
-- for JV-2026-1000, was handed JV-2026-100, and collided with the 100th. Every
-- sequence value from 1000 on maps onto an existing three-digit reference, so the
-- insert fails on journals_reference_key and createJournalEntry() returns null.
--
-- Found on 2026-09-20 posting the bank-receipt backfill: the 2026 book stood at 998
-- journals, the batch crossed 999, and the remaining 297 were rejected. Nothing was
-- half-written — the header insert is what failed — but the counter had already
-- advanced, which is why 2026 references now skip from 999 to 1297. The gap is the
-- honest record of those refused attempts and is left alone; renumbering a posted
-- ledger to close it would be far worse than a hole in the sequence.
--
-- Three digits stay the format below 1000 so every reference already issued keeps
-- its exact spelling; above it the number simply gets longer.
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
  RETURN 'JV-' || p_year || '-' ||
    CASE WHEN v_seq < 1000 THEN LPAD(v_seq::text, 3, '0') ELSE v_seq::text END;
END;
$$;
