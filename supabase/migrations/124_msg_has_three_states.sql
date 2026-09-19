-- "Not pure micin, but not MSG-free either" is the true answer, and a boolean
-- cannot hold it.
--
-- Migration 123 added `subcontractors.uses_msg` yesterday and set Thenie true.
-- That reads as "this kitchen uses MSG", and it is not what Thenie do. The
-- answer an admin already sent a customer on 2026-09-09, in these words:
--
--   "Dapur partner kami tidak memakai micin/MSG murni. Penyedapnya pakai kaldu
--    jamur merek Totole. Jadi bukan bebas penguat rasa sama sekali, tapi bukan
--    micin biasa — saya sampaikan apa adanya biar kakak bisa menilai sendiri."
--
-- Three states, not two, and the middle one is where our kitchens actually
-- sit. A boolean forces it to one of the ends, and both ends are a lie: true
-- says we cook with micin, false says the food is free of flavour enhancer.
-- Someone avoiding MSG deserves the distinction — it is the whole reason they
-- asked — and a customer told the wrong end of it finds out by eating it.
alter table subcontractors
  add column if not exists msg_policy text
  check (msg_policy in ('none', 'penyedap', 'msg'));

comment on column subcontractors.msg_policy is
  'How this kitchen seasons. none = cooks without MSG. penyedap = no pure micin, but a flavour enhancer (kaldu bubuk/jamur) that is not MSG-free. msg = micin used directly. NULL = we have never asked, which is not "none": the prompt escalates rather than claiming either way. Never a promise to cook a portion differently on request.';

-- Carried over from 123. Homey said no MSG, which is `none`; Thenie season
-- with kaldu jamur merek Totole, which is `penyedap` and was never `msg`.
update subcontractors set msg_policy = 'none'     where uses_msg is false;
update subcontractors set msg_policy = 'penyedap' where uses_msg is true;

-- `uses_msg` is dropped in its own migration, after the code that reads
-- `msg_policy` is live. A column read by running code may not vanish in the
-- same push that stops reading it — that is the 074/075 lesson.
