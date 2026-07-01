alter table customers
add column linked_order_id uuid references orders(id) on delete set null;
