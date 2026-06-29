INSERT INTO settings (key, value, description) VALUES
  ('bank_account_number', '4971805760', 'BCA account number for payments'),
  ('bank_account_name', 'Daniel Rahardyan Pramadyo', 'Account holder name'),
  ('bank_name', 'BCA', 'Bank name'),
  ('business_name', 'Pian Yi Catering', 'Display name for messages'),
  ('instagram_handle', '@pianyicatering', 'Instagram for menu reference'),
  ('typing_delay_base_seconds', '3', 'Base typing delay before sending'),
  ('typing_delay_per_char_seconds', '0.05', 'Extra delay per character'),
  ('typing_delay_max_seconds', '12', 'Maximum typing delay cap'),
  ('casual_mode_probability', '0.5', 'Probability of casual tone (0-1)'),
  ('photo_match_confidence_threshold', '0.95', 'Auto-send threshold for delivery photos'),
  ('unpaid_reminder_hours', '2', 'Hours before first payment reminder'),
  ('unpaid_cancel_hours', '24', 'Hours before auto-cancel unpaid order'),
  ('low_quota_first_warning', '3', 'Portions remaining for first renewal warning'),
  ('low_quota_final_warning', '1', 'Portions remaining for final renewal warning'),
  ('order_deadline_hour', '20', 'Cutoff hour for next-day orders (24h format)'),
  ('delivery_areas', '["BSD","Gading Serpong","Alam Sutera","Bintaro","Graha Raya"]', 'Served areas as JSON array'),
  ('escalation_keywords', '["manusia","admin","CS","ngomong sama orang","bukan bot","complain","komplain"]', 'Keywords that trigger human escalation'),
  ('chatbot_enabled', 'true', 'Kill switch for AI chatbot');

INSERT INTO pricing_tiers (portions, price_per_portion) VALUES
  (5, 29000), (10, 28000), (20, 27000),
  (40, 26000), (60, 26000), (120, 25000);

INSERT INTO message_templates (key, template, description) VALUES
  ('subcontractor_libur', 'Halo kak, mohon maaf dapur kami yang biasanya besok libur, besok kita akan kirim dari dapur yang satunya lagi', 'When subcontractor is unavailable'),
  ('late_delivery', 'Mohon maaf kak pengantaran hari ini agak telat ya. Dapur kami lagi agak ramai. Terima kasih kesabarannya 🙏', 'Apology for late delivery'),
  ('food_complaint_initial', 'Mohon maaf sekali kak atas pengalaman tidak menyenangkan ini 🙏 Boleh saya minta fotonya supaya bisa kami evaluasi langsung dengan dapur kami? Kami akan segera tindak lanjuti.', 'Initial response to food quality complaint'),
  ('out_of_area', 'Mohon maaf kak, saat ini kami hanya melayani BSD, GS, Alsut, Bintaro, dan Graha Raya ya 🙏', 'Customer outside delivery area'),
  ('payment_reminder_gentle', 'Halo kak, belum sempat transfer ya? Kalau butuh info lagi saya siap bantu 😊', 'Gentle payment reminder at 2h'),
  ('payment_overdue_final', 'Halo kak, pesanannya kami batalkan dulu ya karena belum ada pembayaran. Kalau masih berminat, silakan hubungi kami lagi 🙏', 'Final notice before auto-cancel at 24h'),
  ('quota_low_first', 'Halo kak, paket kakak tinggal {remaining} porsi lagi 🍱. Mau renewal biar nggak putus? Reply YA ya 😊', 'First quota warning at 3 portions'),
  ('quota_low_final', 'Halo kak, paket kakak tinggal {remaining} porsi lagi nih. Mau lanjut? Reply YA untuk renewal 😊', 'Final quota warning at 1 portion'),
  ('chatbot_unavailable', 'Halo kak! Sistem kami sedang gangguan sebentar. Kak Annie akan balas langsung secepatnya ya 🙏', 'Fallback when Claude API is down'),
  ('rate_limit_exceeded', 'Halo kak, sistem kami sedang sibuk. Kak Annie akan segera membalas ya 🙏', 'Customer hit rate limit'),
  ('text_only', 'Maaf kak, saya hanya bisa memproses pesan teks ya. Boleh diketik pesannya? 🙏', 'Non-text message received'),
  ('human_escalation', 'Mohon maaf kak, untuk hal ini saya akan hubungkan dengan tim kami ya. Kami akan segera menghubungi kakak. Terima kasih atas kesabarannya! 🙏', 'Escalation to human agent'),
  ('after_hours', 'Halo kak, karena sudah lewat deadline jam 8 malam, pesanan bisa diproses untuk lusa ya. Mau lanjut? 😊', 'Order after 8pm cutoff');
