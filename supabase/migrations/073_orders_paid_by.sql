-- Who is paying for an order that is not their own.
--
-- A customer buying a package for someone else has been a real pattern since
-- July and the schema had no way to say it: the order could sit on the buyer
-- (so the food is scheduled against the wrong address and the wrong quota) or
-- on the beneficiary (so nobody knows who owes the money, and every unpaid
-- sweep chases a person who never spoke to us). On 2026-07-07 Maria Marcella
-- extended Fiana's package and one purchase came out as two orders on two
-- customers; on 2026-08-24 Naya ordered for Cila and the friend's order was
-- overwritten by Naya's own within the same minute.
--
-- The order stays on the person who eats the food. This column names the
-- person who owes for it. Null on every ordinary order, which is nearly all
-- of them.
alter table orders
  add column if not exists paid_by_customer_id uuid references customers(id);

comment on column orders.paid_by_customer_id is
  'Customer who is paying for this order when that is not the customer receiving it — a package bought for a friend, a child, a colleague. Null when the buyer and the recipient are the same person. The payment conversation, the transfer instructions and the unpaid reminder all belong to this customer; the deliveries and the quota belong to orders.customer_id.';

create index if not exists orders_paid_by_customer_id_idx
  on orders (paid_by_customer_id)
  where paid_by_customer_id is not null;
