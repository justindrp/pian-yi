-- Per-kitchen delivery areas, corrected from the owner's own account of who
-- drives where, and the removal of the plain "BSD" entry.
--
-- "BSD" predates the BSD Baru / BSD Lama split. It survived on two rows and had
-- no meaning left: every BSD customer is recorded as one of the two halves, no
-- customer carries "BSD" as their area, and area_neighborhoods has never held a
-- row for it. What it did do was reach the bot, which offered "BSD" beside
-- "BSD Baru" and "BSD Lama" as if it were a third neighbourhood, and the price
-- sheet footer, which printed all three.
--
-- Santapin drives everywhere Thenie drives, plus Bintaro.
--
-- Homey covers Tangerang and Jakarta Barat. Tangerang is written out as the
-- five areas we actually name plus Bintaro, since delivery_areas is a list of
-- our own area vocabulary and not a list of regencies. Jakarta Barat is new to
-- that vocabulary and has no area_neighborhoods rows yet, so the bot has no
-- cluster names to recognise there — it is inert either way until Homey is
-- activated, but the neighbourhoods have to land before it is.

update subcontractors
   set delivery_areas = '["Alam Sutera","Gading Serpong","BSD Baru","BSD Lama","Karawaci","Bintaro"]'::json
 where name = 'Santapin';

update subcontractors
   set delivery_areas = '["Alam Sutera","Gading Serpong","BSD Baru","BSD Lama","Karawaci","Bintaro","Jakarta Barat"]'::json
 where name = 'Homey Catering';

update subcontractors
   set delivery_areas = '["Gading Serpong","Alam Sutera","BSD Baru","BSD Lama"]'::json
 where name = 'Yuk Makan';
