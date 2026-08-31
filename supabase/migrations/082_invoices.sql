-- Invoices, so the bot can send one itself.
--
-- Both invoices sent to a customer so far were rendered by hand: the first by a
-- throwaway script on 2026-08-30 that was deleted the same day, the second on
-- 2026-08-31 after Carolin asked for a correction and the layout had to be
-- rebuilt from a screenshot. Neither left a record anywhere — not the number,
-- not the amount, not that it had been sent — so nothing could answer "what did
-- we invoice her, and when?" except the WhatsApp thread.
--
-- One row per order. The number is allocated once and never re-allocated: a
-- customer who asks for the invoice again gets the same number on a freshly
-- rendered PDF, because the paid/unpaid state on it may have changed since.
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  -- One invoice per order. A second package is a second invoice, which is what
  -- Carolin's 5-box and 1-box susulan were.
  order_id uuid not null unique references public.orders(id) on delete cascade,
  -- Who it is billed to. On a package bought for someone else this is the
  -- payer (orders.paid_by_customer_id), not the person who eats the food —
  -- the invoice follows the money.
  customer_id uuid not null references public.customers(id),
  number text not null unique,
  issued_on date not null,
  -- What the invoice was rendered at, in IDR. Kept because orders.total_price
  -- can be edited afterwards and a sent invoice is a statement of fact.
  total integer not null,
  -- The PDF as sent, in the menu-images bucket. Nullable only for the window
  -- between allocating the number and the upload landing.
  pdf_url text,
  sent_count integer not null default 0,
  last_sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists invoices_customer_idx on public.invoices (customer_id);

-- Sequence per calendar month, mirroring journal_sequences. A month is short
-- enough that the running number stays small and long enough that it is not
-- reset by a quiet week.
create table if not exists public.invoice_sequences (
  period text primary key,
  last_seq integer not null default 0
);

-- Allocated in the database, not in Node: two concurrent sends would otherwise
-- read the same last_seq and the unique constraint on number would fail the
-- second one after its PDF had already been rendered.
create or replace function public.next_invoice_number(p_period text)
returns text
language plpgsql
as $$
declare
  seq integer;
begin
  insert into public.invoice_sequences (period, last_seq)
  values (p_period, 1)
  on conflict (period) do update
    set last_seq = public.invoice_sequences.last_seq + 1
  returning last_seq into seq;
  return 'INV/PY/' || p_period || '/' || lpad(seq::text, 4, '0');
end;
$$;

alter table public.invoices enable row level security;
alter table public.invoice_sequences enable row level security;

-- Server-only. The bot's tool and the dashboard route both run as the service
-- role; the browser client never reads or writes these.
create policy "service role manages invoices"
  on public.invoices for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service role manages invoice sequences"
  on public.invoice_sequences for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table public.invoices is
  'One invoice per order. Number allocated once by next_invoice_number(); the PDF is re-rendered on every resend because the paid state can change.';
comment on column public.invoices.customer_id is
  'Who is billed — the payer on a package bought for someone else, not orders.customer_id.';
comment on column public.invoices.total is
  'The amount on the PDF as sent. Not re-read from orders.total_price, which can be edited later.';
