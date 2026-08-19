-- Corporate (custom-price) customers.
--
-- Every price in this system is derived from `pricing_tiers`: the largest tier
-- at or below the package size, times the size. That ladder tops out at
-- Rp 29.000 and only ever goes down as the order grows, which is right for a
-- personal customer and wrong for a company. PT Bintang Lautan Sejahtera buys
-- 110 porsi at Rp 35.000 — above every tier that has ever existed — so no code
-- path could produce their order, and the replay harness could only ever score
-- it as unreproducible.
--
-- `contract_price_per_portion` is that negotiated rate. When it is set, it
-- replaces the tier lookup entirely (add-ons still stack on top) and the
-- 5-or-6 divisibility rule does not apply: a company buys box counts, not
-- packages. NULL means an ordinary customer priced off the ladder — the only
-- state that existed before this migration, and still the default.
alter table customers
  add column if not exists contract_price_per_portion integer;

comment on column customers.contract_price_per_portion is
  'Negotiated per-portion rate for corporate customers, in IDR. When set it overrides the pricing_tiers ladder and lifts the 5/6 divisibility rule. NULL = ordinary tier pricing.';

-- Partial payment. Corporate orders arrive with a DP and settle later, and the
-- order lifecycle has no room for "half paid": pending_payment -> proof
-- received is binary. Rather than build a second payment state machine for one
-- customer, record what has actually landed and let an admin decide when the
-- order is paid. 0 means nothing recorded, which is every order to date.
alter table orders
  add column if not exists amount_paid integer not null default 0;

comment on column orders.amount_paid is
  'IDR received against this order so far. Set by an admin for partial/DP payments; total_price stays the contracted amount. 0 on every order that settles in one transfer.';
