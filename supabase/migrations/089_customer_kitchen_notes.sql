-- The kitchen sheet cooks from a field nothing owned.
--
-- /dapur/[id] printed a "Preferensi:" bullet lifted out of the [AI learned
-- context] block in customers.notes, which learnCustomerContext() rewrites
-- wholesale on new messages. So a dietary instruction reached the cook only if
-- the summarizer happened to re-summarize it correctly, and an invented one
-- reached them the same way. On 2026-09-01 Carolin's 6 lunch portions were
-- cooked "tanpa nasi + no pedas" off a preference she had never given and had
-- cancelled 28 hours earlier; two hand corrections of her notes had already
-- been overwritten by the summarizer.
--
-- kitchen_notes is the field the sheet reads from now: written only by an admin
-- or by extract_order's `catatan`, never by the summarizer.
alter table customers add column if not exists kitchen_notes text;

comment on column customers.kitchen_notes is
  'What the kitchen must do differently for this customer, in the customer''s own terms ("tanpa nasi", "tidak ada kacang"). Printed on the unauthenticated /dapur/[id] sheet. Written by an admin or by extract_order; never by learnCustomerContext(), and never derived from a chat summary.';

-- Seed it with the manual half of notes — everything before the AI block, which
-- is what an admin typed and what mergeKitchenNote() has been appending. The AI
-- half is deliberately not carried over: an invented restriction is exactly
-- what this column exists to stop, and the genuine ones are re-entered by hand.
update customers
set kitchen_notes = nullif(btrim(split_part(notes, '[AI learned context]', 1)), '')
where kitchen_notes is null
  and notes is not null
  and nullif(btrim(split_part(notes, '[AI learned context]', 1)), '') is not null;
