-- The tanpa-nasi flag learns about the orders that pre-date it.
--
-- Migration 116 added `orders.no_rice` with `default false`, which is the
-- right default for a new order and a wrong answer for every order that
-- already existed. The morning after it shipped the column read false on all
-- 324 active orders, 13 of which belong to customers whose
-- `customers.kitchen_notes` say tanpa nasi — so the structured field said "no"
-- for every customer who is in fact on lauk-only, and the first code path to
-- trust it over the free text would have been wrong for all of them.
--
-- Nothing was mispriced in the meantime: the discount only comes off at a
-- kitchen whose `no_rice_discount` is set, the affected orders are all on
-- kitchens where it is NULL, and the kitchen kept cooking correctly because
-- the sheet prints `kitchen_notes` and every one of those notes says tanpa
-- nasi. The flag was wrong, not the food and not the money.
--
-- `kitchen_notes` is the source because it is the only record of the request
-- that existed before this column did — the one thing the kitchen has always
-- cooked from (migration 089). It is customer-level and current, which is why
-- this only touches orders that are still live: a completed or cancelled
-- order's notes may describe how the customer eats today rather than what they
-- bought in June, and re-stating history from a field that has moved on is how
-- a backfill invents facts. Those orders keep false, which for a finished
-- package is a column nobody reads rather than a claim that it had rice.
--
-- The four near-misses in the notes today are all correctly left alone by the
-- `tanpa\s+nasi` match: "Porsi nasi kurangin sedikit", "Nasi Merah 1/2",
-- "(+1 NASI)" and "(+Nasi merah 1 hari aja di senin...)".
--
-- One-off. Orders created from 2026-09-15 set the flag through
-- `extract_order`, so nothing after this needs the rescue.
update orders o
set no_rice = true
from customers c
where c.id = o.customer_id
  and o.no_rice = false
  and o.status in ('active', 'paused', 'payment_proof_received', 'pending_payment')
  and c.kitchen_notes ~* 'tanpa\s+nasi';
