-- The schedule a customer asked for, held between order creation and payment.
--
-- Until now createOrderFromExtraction wrote daily_deliveries rows the moment
-- the order was created, while it was still pending_payment. Nothing filters
-- the kitchen sheet by order status -- GET /api/deliveries/daily-sheet embeds
-- orders(...) but keys only on delivery_date -- so an unpaid order put food on
-- a kitchen's sheet. On 2026-08-28 three unpaid orders (Cindi 12, Cila 5, Naya
-- 20) held 37 future portions nobody had paid for.
--
-- Rows now land at mark_paid instead. But payment can be a day or two after the
-- order, and between the two the schedule exists only in the chat, so it needs
-- somewhere to live. That is this column: written once at order creation from
-- the extraction, read once by mark_paid to write the rows, never read again.
-- The delivery rows are the truth from then on.
--
-- Shape: [{ "date": "2026-09-02", "meal_type": "lunch", "portions": 1 }, ...]
--
-- This replaces orders.meal_time_preference rather than renaming it. The enum
-- was a lossy summary of a schedule -- it could not express Veronica's
-- "Senin-Kamis dinner; Jumat & Sabtu lunch & dinner", and reading a delivery
-- row against it produced a false bug report on food that was correct. A date
-- list expresses every customer. Dropped in a later migration, once no code
-- reads it.
--
-- NULL means the customer bought quota without naming days (most of the book).
-- Those orders get no rows at payment; rows appear per booking via
-- record_daily_order, exactly as they do today.

alter table orders add column if not exists requested_schedule jsonb;

comment on column orders.requested_schedule is
  'Days the customer asked for at order creation: [{date, meal_type, portions}]. Consumed by mark_paid to write daily_deliveries, then never read again -- the rows are the truth. NULL = quota with no named days.';
