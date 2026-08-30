-- The Payments page printed "Proof received <time>" off `confirmed_at`, which
-- is when the order was confirmed, not when the money showed up. Naya's proof
-- arrived 2026-08-30 13:33 WIB and the row read "24 Agu 2026, 12.12"; Cila's,
-- flipped by the same proof, read "27 Agu 2026, 12.20". Nothing in the schema
-- held the answer, so the page could only show a date that looked like one.
--
-- Left NULL for every row already in the table. The page says "Order confirmed"
-- for those instead of inventing a proof time it does not have.
alter table orders add column if not exists payment_proof_received_at timestamptz;

comment on column orders.payment_proof_received_at is
  'When the payment proof arrived. Set wherever status becomes payment_proof_received; NULL for orders that reached that status before migration 079.';
