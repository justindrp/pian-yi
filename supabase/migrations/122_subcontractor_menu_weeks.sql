-- Every week of a kitchen's menu we have been given, not just the live one.
--
-- `subcontractors.menu_text` holds exactly one week — the week the card on file
-- draws and the week the bot answers from. That is right for reading, and it is
-- why the column stays: nothing here replaces it. What it cannot do is hold a
-- menu we already have but do not yet publish.
--
-- Homey publishes a month at a time, on one poster. On 2026-09-18 that poster
-- covered 31 Agustus through 2 Oktober, and only the 14–18 September week had
-- been transcribed into the column; the other four weeks existed nowhere the
-- app could see, so generating next week's card meant finding the poster again.
-- Task 75a766db is that: "transcribe each week before it starts, or store all
-- four now and move menu_week_start weekly." This table is the second half of
-- that sentence — the poster is transcribed once, and every following week is
-- `scripts/menu-week.ts` promoting a row into the column.
--
-- `week_start` is the Monday, the same key `menu_week_start` carries, so a row
-- here and the live column are comparable without any date arithmetic. The text
-- is stored in exactly the format `parseMenu()` in scripts/menu-card.ts and
-- scripts/menu-photos.ts already read, because a stored week that needs
-- translating before it renders is a week that renders differently from the one
-- an admin typed by hand.
create table if not exists subcontractor_menu_weeks (
  id uuid primary key default gen_random_uuid(),
  subcontractor_id uuid not null references subcontractors(id) on delete cascade,
  -- The Monday the week starts, matching subcontractors.menu_week_start.
  week_start date not null,
  -- Verbatim in the menu_text format: header line, the "what's included" line,
  -- then one "Hari D Bulan: ..." line per cooking day.
  menu_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subcontractor_id, week_start)
);

-- The promoter reads one kitchen's weeks in date order, and that is the only
-- read there is.
create index if not exists idx_subcontractor_menu_weeks_kitchen
  on subcontractor_menu_weeks (subcontractor_id, week_start);

comment on table subcontractor_menu_weeks is
  'One week of one kitchen''s menu, in menu_text format. The store; subcontractors.menu_text is the live week promoted out of it by scripts/menu-week.ts.';

-- Enable RLS; service-role admin client bypasses it for API writes.
alter table subcontractor_menu_weeks enable row level security;

create policy "authenticated manage subcontractor_menu_weeks"
  on subcontractor_menu_weeks
  for all to authenticated using (true) with check (true);

-- Homey's September poster, all five weeks. The 14 September week is the one
-- already live in subcontractors.menu_text on 2026-09-18 and is stored here
-- unchanged, so the store is the whole poster rather than the part still ahead.
-- Keyed by id, not by nickname: the nickname is customer-facing and may be
-- changed, and a seed that silently matches nothing is worse than none.
insert into subcontractor_menu_weeks (subcontractor_id, week_start, menu_text)
values
  ('775e6ba3-7c33-40f6-97e7-e28868f272c6', '2026-08-31',
'31 Agustus s/d 4 September 2026.
Menu siang dan malam sama tiap harinya; nasi, krupuk dan sambal sudah termasuk.
Senin 31 Agustus: Nasi Putih, Sweet & Sour Chicken Hongkong Style, Ekkado, Sop Kentang Kembang Tahu, Krupuk, Garlic Chili Oil.
Selasa 1 September: Nasi Putih, Sapi Lada Hitam, Lumpia Bihun Crabstick, Ayam Cah Jamur Kembang Kol, Krupuk, Sambal Bawang.
Rabu 2 September: Nasi Putih, Chicken Ball Bolognese Sauce, Sempol Ayam Goreng, Sop Makaroni, Krupuk, Sambal Sachet.
Kamis 3 September: Nasi Putih, Ikan Cakalang Cabe Ijo, Kering Kentang Serundeng, Opor Tahu Tempe, Krupuk, Sambal Bawang.
Jumat 4 September: Nasi Putih, Ayam Kalasan, Tempe Mendoan Daun Jeruk, Sop Bening Labu Jagung Manis, Krupuk, Sambal Korek Kemangi, Dessert.'),
  ('775e6ba3-7c33-40f6-97e7-e28868f272c6', '2026-09-07',
'7 s/d 11 September 2026.
Menu siang dan malam sama tiap harinya; nasi, krupuk dan sambal sudah termasuk.
Senin 7 September: Nasi Putih, Ayam Crispy Saos Mentega, Tumis Brokoli Wortel, Sop Jagung Telur Kocok, Krupuk, Sambal Bawang.
Selasa 8 September: Nasi Putih, Ikan Cengcuan, Bakwan Jagung Sosis, Tumis Sawi Hijau Bawang Putih, Krupuk, Sambal Korek.
Rabu 9 September: Nasi Putih, Laksa Ayam, Telur Bacem, Kangkung Goreng Kriuk, Krupuk, Sambal Laksa.
Kamis 10 September: Nasi Putih, Sop Daging Sapi Kacang Merah, Tempe Goreng Lengkuas, Tumis Buncis Bawang Putih, Krupuk, Sambal Bajak.
Jumat 11 September: Nasi Putih, Oseng Ayam Taichan Sambal Matah, Tahu Kipas Serabut, Tumis Tauge Ikan Asin, Krupuk, Sambal Merah Ala Padang, Dessert.'),
  ('775e6ba3-7c33-40f6-97e7-e28868f272c6', '2026-09-14',
'14 s/d 18 September 2026.
Menu siang dan malam sama tiap harinya; nasi, krupuk dan sambal sudah termasuk.
Senin 14 September: Nasi Putih, Chicken Kungpao, Bola-Bola Rambutan, Sayur Oyong Tahu, Krupuk, Garlic Chili Oil.
Selasa 15 September: Nasi Putih, Udang Jagung Saus Padang Telur Kecombrang, Pepes Tahu Teri Jamur, Cah Sawi Putih Bawang Putih, Krupuk, Sambal Bawang.
Rabu 16 September: Nasi Putih, Ayam Woku Kemangi, Bakwan Sayuran, Mun Kentang Kecap, Krupuk, Sambal Daun Jeruk.
Kamis 17 September: Nasi Putih, Ikan Goreng Kremes, Tumis Tempe Kemangi, Sayur Asem, Krupuk, Sambal Dabu-Dabu.
Jumat 18 September: Nasi Putih, Ayam Kukus Pasundan, Bakwan Kulit Pangsit, Sayur Lodeh, Krupuk, Sambal Terasi Tomat, Dessert.'),
  ('775e6ba3-7c33-40f6-97e7-e28868f272c6', '2026-09-21',
'21 s/d 25 September 2026.
Menu siang dan malam sama tiap harinya; nasi, krupuk dan sambal sudah termasuk.
Senin 21 September: Nasi Putih, Tim Ayam Sayur Asin, Baso Goreng Ayam, Cah Brokoli Jamur, Krupuk, Garlic Chili Oil.
Selasa 22 September: Nasi Putih, Cakalang Asap Pedas Daun Jeruk, Martabak Telur, Sop Bakso Lohua, Krupuk, Sambal Bawang Tomat.
Rabu 23 September: Nasi Putih, Ayam Saus Padang, Kari Telur, Tumis Sayur Kangkung, Krupuk, Sambal Rica-Rica.
Kamis 24 September: Nasi Putih, Rawon Daging Sapi, Telur Asin, Tumis Labu Siam Wortel, Krupuk, Sambal Soto.
Jumat 25 September: Nasi Putih, Crispy Vermicelli Karage Chicken, Sate Baso Sosis, Sop Kekian Bengkuang, Krupuk, Sambal Sachet, Dessert.'),
  ('775e6ba3-7c33-40f6-97e7-e28868f272c6', '2026-09-28',
'28 September s/d 2 Oktober 2026.
Menu siang dan malam sama tiap harinya; nasi, krupuk dan sambal sudah termasuk.
Senin 28 September: Nasi Putih, Korean Fried Chicken, Kentang Goreng Bumbu BBQ, Sop Tahu Pedas Korea, Krupuk, Sambal Sachet.
Selasa 29 September: Nasi Putih, Dori Katsu, Spring Roll Ayam Sayuran, Tumis Timun Telur, Krupuk, Sambal Matah.
Rabu 30 September: Nasi Putih, Ayam Gongso, Otak-Otak Balado, Capcay Kuah Ala Chinese, Krupuk, Sambal Bawang.
Kamis 1 Oktober: Nasi Putih, Gulai Daging Sapi, Perkedel Kentang Kornet, Cah Kacang Panjang Bakso, Krupuk, Sambal Bawang.
Jumat 2 Oktober: Nasi Putih, Ayam Suwir Teri Medan Kemangi, Tempe Orek, Sop Bening Bayam Jagung Manis, Krupuk, Sambal Bawang, Dessert.')
on conflict (subcontractor_id, week_start) do nothing;
