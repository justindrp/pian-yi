-- Thenie states her own M tambahan, and five settings rows nothing reads go.
--
-- 1. Dapur Suplir (Thenie) had `size_m_surcharge` NULL and so borrowed
--    `settings.size_m_surcharge` (4000). The figure was right, but it lived in
--    a row that reads as a house-wide default: anyone editing it to change the
--    fallback would have repriced Thenie's M without meaning to. Since
--    migration 131 every kitchen can carry its own figure, and Molls already
--    does (6500). Thenie's goes on her row; the setting stays as the fallback
--    for a kitchen with no figure or a path that cannot name a kitchen.

UPDATE subcontractors
SET size_m_surcharge = 4000
WHERE id = '52cd5e62-da09-49c9-939c-2f1246566c40'
  AND size_m_surcharge IS NULL;

-- 2. Settings rows with no reader anywhere in the code. Each one looked
--    editable and changed nothing, which is worse than not existing. Values
--    at deletion, kept here because nothing else will record them:
--
--    delivery_areas            ["BSD Baru","BSD Lama","Gading Serpong","Alam Sutera"]
--                              — areas come from active kitchens'
--                              `subcontractors.delivery_areas` (the welcome
--                              message's {{delivery_areas}} included)
--    weekly_menu               '' — menus are `subcontractors.menu_text`
--    weekly_menu_image_url     .../menu-images/weekly_menu_image_url/1780391525299.jpeg
--    weekly_menu_image_url_dapur2
--                              .../menu-images/weekly_menu_image_url_dapur2/1780391530220.jpeg
--                              — menus are `subcontractors.menu_image_url`
--    order_deadline_daily_hour 16 — dead since 2026-09-16; the cutoff is
--                              `order_deadline_hour` for every flow
--
--    `price_list_image_url` stays: it is still read as the fallback sheet for
--    a kitchen with no `subcontractors.price_list_image_url` of its own.

DELETE FROM settings
WHERE key IN (
  'delivery_areas',
  'weekly_menu',
  'weekly_menu_image_url',
  'weekly_menu_image_url_dapur2',
  'order_deadline_daily_hour'
);
