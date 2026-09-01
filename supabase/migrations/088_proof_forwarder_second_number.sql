-- Add the second (manual) WhatsApp handset to the proof-forwarder allowlist.
-- It is the number used for closed-window outreach, so it is the one actually
-- in someone's hand at a drop, and photos taken on it had no path to the
-- customer: not a subcontractor, so `handleSubcontractorMessage` ignores it,
-- and not allowlisted, so its images fell through to the bot as payment proofs.
--
-- Appended rather than overwritten: the value is edited at /settings, so a
-- plain UPDATE would throw away whatever numbers have been added since 083.
UPDATE settings
SET value = value || ',+6285128024390',
    updated_at = now()
WHERE key = 'proof_forwarder_phones'
  AND value NOT LIKE '%+6285128024390%';
