-- Assign Karawaci customers to Route 2
update customers set delivery_route = 2 where area = 'Karawaci';

-- Recompute positions for all Route 2 customers (stable order by name)
with ranked as (
  select id,
    row_number() over (order by name nulls last) - 1 as pos
  from customers
  where delivery_route = 2
)
update customers set delivery_position = pos from ranked where customers.id = ranked.id;
