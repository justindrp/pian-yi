-- A one-off event booking is a purchase, but it is not a package anyone
-- renews. Ade Dian's ICE BSD order — 180 portions across 21–23 Agustus 2026,
-- breakfast/lunch/dinner for three days — sat in the expiry report as a
-- customer whose quota had run out, next to twelve real subscribers.
-- `source` already separates a purchase from a granted portion; 'event' is the
-- third kind. Both readers of the column switch on 'free_quota' alone
-- (src/app/api/customers/[id]/route.ts, src/app/api/orders/[id]/ledger/route.ts),
-- so an event order keeps displaying as the purchase it is.
alter table orders drop constraint if exists orders_source_check;
alter table orders add constraint orders_source_check
  check (source in ('purchase', 'free_quota', 'event'));

comment on column orders.source is
  'purchase (default) | free_quota (admin-granted goodwill, Rp 0) | event (a one-off catering booking, not a renewable package — excluded from renewal and expiry reporting).';
