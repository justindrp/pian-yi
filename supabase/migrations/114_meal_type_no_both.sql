-- daily_deliveries.meal_type may not be 'both'.
--
-- 'lunch' and 'dinner' are the standing meals; 'breakfast' is real too, and
-- belongs to event orders — the ICE BSD event in August was 60 breakfast
-- portions across three days, and /dapur/[id] renders them. This constraint
-- does not touch it.
--
-- 'both' is the one that had to go. A row carrying two meals is invisible food:
-- every consumer buckets by an equality test on meal_type, so it matches no
-- column, renders nowhere, reaches no kitchen and is counted in no total. It
-- still spends the customer's quota, so the ledger reads "booked" for food
-- nobody cooked. Three rows reached production this way:
--
--   2026-07-17  Vania, 2 porsi
--   2026-07-24  Vania, 2 porsi
--   2026-09-14  Veronica Catherine, 2 porsi
--
-- All three were written by record_daily_order, which passed the bot's
-- meal_type straight through while the tool's enum still offered "both". They
-- were deleted on 2026-09-14 — copied into edit_log first — and the portions
-- returned to the customers' unbooked balance, because none of that food was
-- ever cooked. Veronica's were the two portions we owed her for the Sabtu 12
-- September delivery we cancelled: the bot rebooked them onto a date no kitchen
-- could see, so she went a second day with nothing and the ledger said she had
-- nothing left to schedule.
--
-- The constraint is the point. Nothing rejected 'both' before, so it was a
-- silent insert the bot reported back as a successful booking. It is now a
-- failed insert record_daily_order surfaces to the model, which is an error
-- somebody sees.

ALTER TABLE daily_deliveries
  ADD CONSTRAINT daily_deliveries_meal_type_not_both
  CHECK (meal_type <> 'both');
