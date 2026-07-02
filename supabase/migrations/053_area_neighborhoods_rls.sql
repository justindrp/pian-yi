-- Enable RLS; service-role admin client bypasses it for API writes.
alter table area_neighborhoods enable row level security;

create policy "authenticated manage area_neighborhoods" on area_neighborhoods
  for all to authenticated using (true) with check (true);

