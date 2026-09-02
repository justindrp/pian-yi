-- Delivery windows belong to the kitchen, not to the meal.
--
-- The window is quoted to customers in the schedule block of the bot's prompt
-- and again in the "belum sampai" answer from send_delivery_proof, and it was
-- one pair of constants for everybody: siang 10.00-12.00, malam 16.00-18.00.
-- Dapur 1 does not work that way. Its courier reached Synergy Building at
-- 12.00 on 2026-09-01 and its delivery photo for 2026-09-02 was taken at
-- 12.09 — at and then past the end of a window we had promised in writing.
-- Naya asked "kak cateringnya udh dianter?" at 11.09 that morning and was
-- inside her window by our own numbers and outside it by the kitchen's.
--
-- Stored in minutes from midnight rather than whole hours: the real window is
-- 11.30-12.30, and an hour-resolution column cannot hold it. Null means the
-- kitchen has not been measured and the defaults in
-- src/lib/deliveries/windows.ts apply, which is the honest state for the five
-- kitchens that are not currently cooking.
ALTER TABLE subcontractors
  ADD COLUMN lunch_window_start_min  int,
  ADD COLUMN lunch_window_end_min    int,
  ADD COLUMN dinner_window_start_min int,
  ADD COLUMN dinner_window_end_min   int;

COMMENT ON COLUMN subcontractors.lunch_window_start_min IS
  'Minutes from midnight WIB. Null falls back to DELIVERY_WINDOWS in src/lib/deliveries/windows.ts.';

-- Dapur 1, measured against two consecutive days of arrivals. Its dinner
-- window has not been measured, so it stays on the default.
UPDATE subcontractors
   SET lunch_window_start_min = 690,  -- 11.30
       lunch_window_end_min   = 750   -- 12.30
 WHERE name = 'Thenie';

-- Some customers meet the courier instead of being delivered to.
--
-- Synergy Building refuses a lobby drop, so Naya, Cila and Winy come down and
-- take the box from the courier's hand. The courier photographs a delivery he
-- leaves; a hand-off he does not, which is why 2 of Naya's first 3 deliveries
-- have no `delivery_proofs` row and both were eaten. Without this flag the
-- absence of a photo reads as the absence of a delivery, and on 2026-09-02 the
-- bot was about to be taught to say exactly that: "makanannya belum sampai".
-- For these customers the only true statement is that we hold no photo.
ALTER TABLE customers
  ADD COLUMN collects_from_courier boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN customers.collects_from_courier IS
  'Customer takes the box from the courier by hand (building refuses a lobby drop), so a missing delivery photo does not mean the food never arrived.';
