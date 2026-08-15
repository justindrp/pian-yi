-- Which week a subcontractor's menu_image_url covers, as the Monday of that week.
--
-- Nothing recorded this before, so the chatbot prompt and the send_menu_image
-- tool both simply asserted the stored image was always the current week. The
-- menu is published every Friday for the following week, so that assertion is
-- false from Friday until Sunday night. On Saturday 2026-08-15 Vania asked for
-- next week's menu while next week's menu (Batch 50, 17-22 Agustus) was already
-- uploaded, and the bot refused to send it and told her to come back on Friday.
ALTER TABLE subcontractors
  ADD COLUMN IF NOT EXISTS menu_week_start date;

COMMENT ON COLUMN subcontractors.menu_week_start IS
  'Monday of the week menu_image_url covers. Defaulted on upload by defaultMenuWeekStart() (Fri/Sat/Sun uploads are next week), editable on the subcontractor form.';

-- Backfilled from the image itself, not from updated_at. The only active
-- kitchen's image reads "BATCH 50 / 17 - 22 Agustus" and was uploaded on
-- Thursday 2026-08-13, so any rule keyed on the upload day would have tagged it
-- as the current week and reintroduced the same bug.
--
-- Inactive kitchens are left null: they keep a stale image, nobody knows which
-- week it was for, and send_menu_image already filters them out.
UPDATE subcontractors
SET menu_week_start = DATE '2026-08-17'
WHERE name = 'Thenie'
  AND is_active = true
  AND menu_image_url IS NOT NULL;
