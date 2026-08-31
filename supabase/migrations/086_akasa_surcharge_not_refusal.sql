-- Thenie's second answer about the two neighborhoods it had refused: Kost Casa
-- Living stays a flat no, but Apartemen Akasa it will deliver to for an extra
-- Rp 10.000 per drop. Migration 085 seeded both as refusals; this turns the
-- Akasa row into a surcharge so the bot sells there again, priced.
update subcontractor_neighborhoods sn
set can_deliver = true,
    surcharge_per_delivery = 10000,
    updated_at = now()
from area_neighborhoods an
where an.id = sn.neighborhood_id
  and an.area = 'BSD Lama'
  and an.name = 'Apartemen Akasa';
