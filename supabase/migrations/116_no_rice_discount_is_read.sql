-- The tanpa-nasi discount stops being a column nobody reads.
--
-- Migration 098 added `subcontractors.no_rice_discount` — IDR off per portion
-- for a box without rice, per kitchen — and nothing has ever read it. The
-- price sheets advertise "Tanpa Nasi" under REQUEST CATERING, and
-- `src/lib/claude/prompts/system.ts` told the bot to say, verbatim, "harga
-- sama, tidak ada biaya tambahan". That sentence is a fact about one kitchen
-- written as a fact about the business, the same mistake the +25% sayur claim
-- made before it: Dapur Palem discount Rp 2.000 and Dapur Monstera Rp 4.000,
-- so a tanpa-nasi customer on either was quoted the full rate on a promise the
-- prompt made for them. On 2026-09-15 a BSD Lama lead was told it out loud at
-- 08:47 WIB before she had even named an area.
--
-- Decided 2026-09-15 by Justin: pass the column through. The prompt renders
-- the sentence per kitchen from this column, and the quote subtracts it.

-- Which orders the discount applies to. A price cannot key off free text, and
-- free text is all there was: `extract_order` carries `catatan` (task
-- 8b88d8f6) and it is printed on the kitchen sheet, not read by pricing. So
-- the request gets a field of its own, the way nasi merah has one.
--
-- The rate is still frozen into `price_per_portion` at creation, exactly like
-- the nasi merah add-on and the size-M surcharge — this column records what
-- that rate was computed from so an amendment can reprice with it instead of
-- quietly dropping it. An away day cooked by another kitchen carries its own
-- kitchen's discount inside the frozen `price_per_portion` in
-- `requested_schedule` and on `daily_deliveries` (migration 102), so there is
-- nothing per-row to store here.
alter table orders
  add column if not exists no_rice boolean not null default false;

comment on column orders.no_rice is
  'The customer bought this package tanpa nasi. Subtracts subcontractors.no_rice_discount per portion, frozen into price_per_portion at creation. The kitchen still reads the request from customers.kitchen_notes.';

-- NULL was ambiguous and both readings were in the same migration: the column
-- comment said "this kitchen does not sell one", the prose above it said
-- Thenie's "price is the same either way, so there is nothing to knock off".
-- Those are different behaviours — refuse the request, or accept it at the
-- full price — and refusing is the one that has already cost a lead: on
-- 2026-08-26 the bot answered "kami hanya melayani paket lengkap" to "kl hanya
-- lauknya bisa kak ?" and the lead left (task cc4a0e98). Tanpa nasi is always
-- accepted. NULL means only that there is nothing to take off the price.
comment on column subcontractors.no_rice_discount is
  'IDR off per portion for a tanpa-nasi box, flat across every tier. NULL or 0 = this kitchen charges the same either way. Never a reason to refuse the request: every kitchen accepts tanpa nasi.';
