-- The second half of migration 124, deliberately held back a push.
--
-- 124 added `msg_policy` and backfilled it from `uses_msg`, but left the
-- boolean in place: the code reading `msg_policy` was not live yet, and a
-- column the running code still selects may not vanish in the same push that
-- stops reading it. That is the 074/075 lesson. Commit c867b3d deployed at
-- 18:36 WIB on 2026-09-19; every builder now selects `msg_policy` and nothing
-- anywhere reads `uses_msg`, so the boolean can go.
--
-- Nothing is lost by dropping it. `uses_msg` could only say yes or no, and the
-- answer our kitchens actually give is the middle one — Thenie seasons with
-- kaldu jamur, which is neither micin nor MSG-free. `msg_policy` carries all
-- three states plus NULL for a kitchen nobody has asked yet, so the boolean
-- holds no fact the text column does not.

alter table subcontractors drop column if exists uses_msg;
