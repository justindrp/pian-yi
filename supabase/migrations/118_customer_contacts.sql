-- A delivery recipient who is not the customer, and may ask for the proof photo.
--
-- Ireine's 20-portion package is delivered to a security desk in B1; the person
-- who actually receives the boxes is Abby, on a different number. On 2026-09-15
-- Ireine asked whether the courier had contacted Abby and there was no way for
-- Abby to ask us anything herself: an inbound message is matched to a customer
-- by `customers.phone_number` alone, so Abby's number would have created a
-- blank customer row, run the welcome sequence, and — when she asked for the
-- photo — been told "tidak ada jadwal pengiriman untuk kakak", because the
-- proof is keyed on `delivery_proofs.matched_customer_id` and that is Ireine.
--
-- A row here says: this number may see this customer's delivery photos, and
-- nothing else. The restricted webhook path it drives gives the thread two
-- tools (send_delivery_proof, ask_admin_for_help) and a prompt that refuses
-- prices, quota, payment state and ordering — a recipient is not the buyer and
-- must not be able to spend the buyer's money or read their ledger.
--
-- `phone_number` is unique because it is the thing the webhook looks a message
-- up by: two owners for one number is a question with no answer. It is stored
-- in `+62…` form, the same form `customers.phone_number` holds, so the lookup
-- is an equality test and not a guess.
create table if not exists customer_contacts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  phone_number text not null unique,
  name text,
  created_at timestamptz not null default now()
);

create index if not exists idx_customer_contacts_customer
  on customer_contacts (customer_id);

-- Enable RLS; service-role admin client bypasses it for API writes.
alter table customer_contacts enable row level security;

create policy "authenticated manage customer_contacts"
  on customer_contacts
  for all to authenticated using (true) with check (true);
