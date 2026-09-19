-- How a kitchen seasons its food is a fact about that kitchen.
--
-- "Tanpa MSG bisa?" has been asked four times since 1 September and answered
-- none of them, because the answer existed nowhere: `system.ts` has no line
-- about MSG, micin, penyedap or kaldu, so the model either fell through to the
-- custom-request decline ("kami belum bisa akomodasi permintaan khusus") or
-- said nothing at all. On 2026-09-04 a lead asked three times in a row — "Mau
-- catering rantangan bisa? Tanpa msg bisa?", "Boleh tolong tanyain dlu ya bisa
-- tanpa msg ga", "Bisa non msg ga" — and left. On 2026-09-17 another asked "Ga
-- pake MSG kan ya ?" and their window shut with the question still open.
--
-- Justin gave the answer on 2026-09-19: Homey cook without MSG, Thenie season
-- with Totole (a chicken bouillon that contains it). That is two facts about
-- two kitchens, so it is a column and not a sentence. Written as a sentence it
-- would repeat the bug `same_menu_both_meals` (097) and `no_rice_discount`
-- (116) were each added to undo — a fact about one kitchen quoted on behalf of
-- all of them, which lies the moment a kitchen is renamed and stays silent for
-- the next kitchen it becomes true for.
--
-- The brand stays here, out of the prompt: a customer asking about MSG is
-- asking whether it is in the food, not which bouillon we buy. The prompt
-- renders yes or no, by customer_nickname.
alter table subcontractors
  add column if not exists uses_msg boolean;

comment on column subcontractors.uses_msg is
  'Does this kitchen season with MSG (micin/penyedap/kaldu bubuk)? false = cooks without it, true = uses it, NULL = we have never asked. NULL is not "no": the prompt must escalate rather than claim either way, because a wrong answer here is a lie about what someone is eating.';

-- Homey: no MSG.
update subcontractors set uses_msg = false where name = 'Homey Catering';

-- Thenie: Totole chicken bouillon, which contains MSG.
update subcontractors set uses_msg = true where name = 'Thenie';

-- Santapin stays NULL deliberately. Nobody has asked them, and guessing on
-- behalf of a kitchen is the thing this column exists to stop.
