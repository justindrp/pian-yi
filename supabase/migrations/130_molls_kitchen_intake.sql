-- Molls Kitchen (Dapur Kaktus) intake, from Ika's answers 2026-09-21/22.
--
-- The row has existed since 2026-08-20, opened for the ICE BSD event tender.
-- This records what the kitchen told us about its daily operation. It does
-- NOT activate them and does NOT touch cost_per_portion: see the notes at the
-- bottom for the three things that must land first.

update subcontractors set
  -- S 20.000 / M 25.000 quoted 2026-09-21. cost_per_portion stays at the
  -- 15.000 event tender on purpose — accrue-deliveries.ts reads it live, so
  -- moving it re-costs August's six ICE BSD rows on the next replay.
  cost_per_portion_m = 25000,
  offers_size_m = true,

  -- "pake micin n penyedap" — micin directly, so 'msg', not 'penyedap'.
  msg_policy = 'msg',

  -- "tidak ada potongan harga akan tetapi menu lauk di lebihkan". Kolom ini
  -- integer (rupiah potongan), bukan boolean - jadi 0, bukan false.
  no_rice_discount = 0,

  -- "Semua" to daily and event both.
  takes_events = true,

  -- Lunch and dinner differ every day of the rotation below.
  same_menu_both_meals = false,

  menu_week_start = '2026-09-28',
  menu_text = $menu$SENIN
Siang: Ayam kecap - Tumis buncis wortel - Tempe goreng - Sambal
Malam: Ikan goreng sambal matah - Tumis kangkung - Tahu - Sambal
SELASA
Siang: Tongkol balado - Capcay sayur - Tahu goreng - Sambal
Malam: Ayam cabe ijo - Tumis kol wortel - Bakwan jagung - Sambal
RABU
Siang: Ayam suwir cabe ijo - Tumis kol wortel - Bakwan jagung - Sambal
Malam: Telur teri balado - Tumis kangkung - Tempe orek - Sambal
KAMIS
Siang: Tongseng ayam - Bakwan jagung - Tempe orek - Sambal
Malam: Ikan bumbu kuning - Sayur bening - Perkedel kentang - Sambal
JUMAT
Siang: Ayam semur - Cah manisa - Tahu goreng - Sambal
Malam: Tongkol woku - Tumis sawi jagung - Tempe goreng - Sambal
SABTU
Siang: Ayam goreng terasi - Tumis sawi jagung - Perkedel kentang - Sambal
Malam: Ayam saus tiram - Cah pokcoy - Tahu crispy - Sambal$menu$,

  notes = $notes$Event tender ICE BSD 21-23 Agustus 2026. Tarif tender Rp 15.000/porsi (flat, kedua rute).

Intake harian 2026-09-21/22, dari Ika (pemilik, BCA 0910081322). Dapur di Jakarta Timur.
- Biaya: S Rp 20.000, M Rp 25.000 per porsi, belum termasuk ongkir.
- Ongkir per ALAMAT, bukan per trip: Jakarta Rp 10.000, luar Jakarta
  (Tangerang/Bekasi/Depok/Bogor) Rp 20.000. Angka ini direvisi empat kali
  dalam dua hari - kunci tertulis dari Ika sebelum dipakai menghitung.
- Senin-Sabtu. Lunch dan dinner keduanya dikirim SEKALI jalan sebelum jam
  12.00, dalam box terpisah. Tidak ada rit sore.
- Makanan lebih baik masuk kulkas; menurut Ika aman selama ini KECUALI menu
  bersantan. Box dinner duduk ~8 jam sebelum dimakan, jadi dinner hanya boleh
  dijual kalau rotasi dinner-nya bebas santan. Rotasi minggu 2026-09-28 sudah
  bebas santan; satu-satunya menu bersantan adalah tongseng di Kamis SIANG.
- Minimum order 1 box per pengantaran.$notes$,

  updated_at = now()
where id = 'ca6f3ac1-226c-4e3f-a610-fb54f84c4717';

-- NOT DONE HERE, and each one is a reason the kitchen stays inactive:
--
-- 1. pricing_tiers has zero rows for this kitchen, so tiersForKitchen() falls
--    back to the house ladder (Thenie's, 29.000-25.000). Selling Molls on that
--    loses Rp 1.000/porsi in Jakarta and Rp 11.000/porsi in Tangsel once ongkir
--    is counted. Twelve rows must be written before is_active goes true.
-- 2. delivery_areas is still BSD Baru + BSD Lama, the areas where Molls is the
--    worst-priced option we have. The Jakarta areas that make them competitive
--    have no area_neighborhoods rows, and migration-era incident efd39e2 shows
--    an area with no neighbourhoods silently disables record_customer_area.
-- 3. M needs a Rp 6.500 surcharge (25.000 S -> 31.500 M). settings.size_m_surcharge
--    is global at Rp 4.000 and raising it moves Thenie's M from 33.000 to 35.500.
