-- Closes the 1000–1296 hole that migration 126 left in the 2026 journal sequence.
--
-- Migration 126 fixed the LPAD truncation that capped the ledger at 999 entries a
-- year, and left the gap behind on the reasoning that renumbering a posted ledger
-- is worse than a hole in a voucher sequence. That is the right default. It is
-- reversed here deliberately, on facts that are specific to this hole and are not
-- a licence to renumber the next one:
--
--   * Nothing cites a reference above 999. Every reference named in the code, the
--     docs, the task queue and the migrations sits between 001 and 668. Nothing
--     outside `journals.reference` stores a reference at all — `bank_transactions`,
--     `edit_log` and every other link is by uuid — so no row anywhere is left
--     pointing at a number that moved.
--   * The block above the hole is exactly the size of the hole. 1297–1593 is 297
--     journals and 1000–1296 is 297 numbers, because the 297 rejected attempts each
--     burned one number. The shift is a clean slide, not a repack.
--   * It is reversible. Every reference moves by the same constant, so shifting the
--     block back up by 297 restores the previous spelling exactly.
--
-- The hole was evidence of the 297 refusals; migration 126's header and
-- `docs/OPERATIONS.md` keep that record in prose, which is where it belongs — a
-- reader of the ledger cannot tell a crash from a deletion by looking at a hole.
--
-- Guarded and idempotent: it finds the first missing number rather than assuming
-- 1000, does nothing when the sequence is already dense, and so no-ops on a fresh
-- database and on a second apply. Only the first hole is closed — a later one is
-- reported and left, because a second hole means something happened that nobody
-- has looked at yet.

DO $$
DECLARE
  v_min           int;
  v_max           int;
  v_first_missing int;
  v_next_present  int;
  v_shift         int;
  v_moved         int;
BEGIN
  CREATE TEMP TABLE _jref ON COMMIT DROP AS
    SELECT split_part(reference, '-', 3)::int AS n
    FROM journals
    WHERE reference ~ '^JV-2026-[0-9]+$';

  SELECT min(n), max(n) INTO v_min, v_max FROM _jref;
  IF v_min IS NULL THEN
    RAISE NOTICE 'no 2026 journals; nothing to close';
    RETURN;
  END IF;

  SELECT min(g) INTO v_first_missing
  FROM generate_series(v_min, v_max) g
  WHERE NOT EXISTS (SELECT 1 FROM _jref WHERE n = g);

  IF v_first_missing IS NULL THEN
    RAISE NOTICE 'sequence 2026 is already dense (% .. %)', v_min, v_max;
    RETURN;
  END IF;

  SELECT min(n) INTO v_next_present FROM _jref WHERE n > v_first_missing;
  v_shift := v_next_present - v_first_missing;

  -- Two passes. The unique index on `reference` is checked per row, so sliding a
  -- contiguous block down in one statement can collide with a row that has not
  -- moved yet, depending on the order rows happen to be processed in. Parking the
  -- block outside the 'JV-' namespace first makes the order irrelevant.
  UPDATE journals
     SET reference = 'TMPREF-' || reference
   WHERE reference ~ '^JV-2026-[0-9]+$'
     AND split_part(reference, '-', 3)::int >= v_next_present;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  UPDATE journals
     SET reference = 'JV-2026-' ||
       CASE
         WHEN split_part(reference, '-', 4)::int - v_shift < 1000
           THEN lpad((split_part(reference, '-', 4)::int - v_shift)::text, 3, '0')
         ELSE (split_part(reference, '-', 4)::int - v_shift)::text
       END
   WHERE reference LIKE 'TMPREF-JV-2026-%';

  -- The counter must never sit below a number already issued, or the next journal
  -- collides on the unique index — which is the whole failure this closes out.
  UPDATE journal_sequences
     SET last_seq = (SELECT max(split_part(reference, '-', 3)::int)
                       FROM journals WHERE reference ~ '^JV-2026-[0-9]+$')
   WHERE year = 2026;

  RAISE NOTICE 'closed gap at % (% wide): % journals shifted down', v_first_missing, v_shift, v_moved;

  IF EXISTS (
    SELECT 1 FROM generate_series(v_min, v_max - v_shift) g
    WHERE NOT EXISTS (
      SELECT 1 FROM journals
      WHERE reference ~ '^JV-2026-[0-9]+$' AND split_part(reference, '-', 3)::int = g)
  ) THEN
    RAISE NOTICE 'another hole remains in the 2026 sequence; left alone on purpose';
  END IF;
END;
$$;
