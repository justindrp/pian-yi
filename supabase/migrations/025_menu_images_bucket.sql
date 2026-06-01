-- Public bucket for weekly menu and price list images sent to new customers via WhatsApp
INSERT INTO storage.buckets (id, name, public) VALUES ('menu-images', 'menu-images', true)
  ON CONFLICT (id) DO NOTHING;

-- Admins can upload/overwrite/delete objects; public read is handled by the bucket being public
CREATE POLICY "admins_manage_menu_images" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'menu-images')
  WITH CHECK (bucket_id = 'menu-images');
