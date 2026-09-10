-- What the model read off a payment slip, so an admin verifying at /payments
-- can see the figure without opening the image.
--
-- Advisory only. Nothing pays on it: `orders.paid_at` stays a human decision,
-- because marking paid writes `daily_deliveries` rows and nothing filters the
-- kitchen sheet by order status — a forged or misread screenshot would become
-- cooked food.
--
-- Shape: { "amount_idr": int|null, "recipient_name": text|null, "bank":
-- text|null, "datetime": text|null, "is_transfer_receipt": bool,
-- "matches_total": bool|null, "read_at": timestamptz }
alter table orders add column if not exists payment_proof_read jsonb;

comment on column orders.payment_proof_read is
  'Model read of the payment slip image. Advisory only — never a payment decision.';
