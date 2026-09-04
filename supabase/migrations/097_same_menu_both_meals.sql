-- Whether a kitchen cooks the same menu for lunch and dinner.
--
-- The bot's prompt carried this as a sentence naming one kitchen: "Dapur 1
-- serves the same menu for lunch and dinner". That is a fact about Thenie, not
-- about whichever kitchen happens to be first, and it goes wrong two ways — it
-- lies the moment the kitchen is renamed, and it stays silent for the next
-- kitchen that shares its menus. `offers_size_m` (migration 078) had exactly
-- this shape and is read the same way: a per-kitchen boolean the prompt builds
-- its sentence from, so the prompt names precisely the kitchens it is true for.
alter table subcontractors
  add column if not exists same_menu_both_meals boolean not null default false;

comment on column subcontractors.same_menu_both_meals is
  'Kitchen serves the same menu for siang and malam. Drives the prompt sentence; never hardcode a kitchen name for this.';

update subcontractors
   set same_menu_both_meals = true
 where name = 'Thenie';
