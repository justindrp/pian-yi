alter table customers
  add column if not exists delivery_route smallint,
  add column if not exists delivery_position integer;

update customers set delivery_route = 1 where area in ('Alam Sutera', 'BSD Lama');
update customers set delivery_route = 2 where area in ('Gading Serpong', 'BSD Baru');

with ranked as (
  select id,
    row_number() over (partition by delivery_route order by name nulls last) - 1 as pos
  from customers
  where delivery_route is not null
)
update customers set delivery_position = pos from ranked where customers.id = ranked.id;
