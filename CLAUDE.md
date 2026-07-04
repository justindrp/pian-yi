<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Pian Yi Catering — Project Context

This file is read at the start of every Claude Code session. It contains permanent context, conventions, and rules for the project.

## What this project is

A WhatsApp-based ordering system for Pian Yi Catering, a daily catering business serving BSD City, Gading Serpong, Alam Sutera, Bintaro, and Graha Raya in Tangerang Selatan, Indonesia.

Two end users:

- **Customers** — interact only via WhatsApp with an AI chatbot powered by Claude Sonnet 5
- **Admins** (Justin, Annie, Agnes) — interact via a PWA dashboard for operations; Justin and Annie are `owner` role, Agnes is `admin` role (see "User roles" section)

## Tech stack

- **Framework**: **Next.js 16.2.6 exclusively** (App Router) with TypeScript. Do not upgrade or downgrade.
- **Package manager**: **pnpm exclusively**. Never use npm, yarn, or bun. All scripts, install commands, and lockfiles must be pnpm.
- **Linter / formatter**: **Biome exclusively**. Do not use ESLint or Prettier.
- **Hosting**: Railway (always-on Node.js, `output: 'standalone'` mode, NOT serverless)
- **Database**: Supabase (PostgreSQL) with Row Level Security
- **Auth**: Supabase Auth (magic link email login for admins only)
- **AI**:
  - **Sonnet 5** (`claude-sonnet-5`) for normal tasks (customer chat, order conversations, training mode)
  - **Haiku 4.5** (`claude-haiku-4-5`) for lighter tasks (photo matching, classification, sentiment analysis, simple FAQ routing)
- **Messaging**: Meta WhatsApp Business Cloud API v25.0
- **Push notifications**: `web-push` library (no Firebase)
- **Data fetching**: TanStack Query
- **Styling**: Tailwind CSS + shadcn/ui components
- **State management**: TanStack Query for server state, React Context for app state

## Required CLIs

CLI only, no MCPs — MCPs burn too many tokens. Avoid web dashboard where CLI can do job.

- **Supabase CLI** — migrations, RLS policies, seed data, type gen, local dev, project mgmt
- **GitHub CLI** (`gh`) — repo creation, branches, PRs, secrets, Actions, deploy keys
- **Railway CLI** — hosting, deploys, env vars, logs (this is where pian-yi actually runs)

## Workflow

- After every code change, commit and push the current branch unless the user explicitly says not to.
- **REQUIRED before every commit, no exceptions:** Update root `CLAUDE.md` (Recent updates section + any affected API/behavior docs) and root `DATABASE.md` (if schema changed) in the same commit as the code change. Never commit code without updating these files. If you skipped this, make a follow-up commit immediately.
- A git hook bumps the app version on every commit and amends the commit, so pushes often need a second attempt using the new HEAD SHA.

When performing infrastructure work, prefer CLI calls over manual UI clicks so the actions are reproducible and auditable.

## Recent updates (July 4, 2026)

- `16:25 +0700` Added: inbox "bot-help" answers can now be saved as a permanent chatbot rule instead of only answering the one customer. Previously an admin's typed answer to a bot-escalated question (e.g. "can a customer reschedule a day within their 5-day package?") only sent a one-off reply — the bot would keep escalating the same question for every future customer since nothing was written back to the system prompt. `POST /api/inbox/bot-reply` gained an opt-in `save_as_rule` boolean (paired with the existing `admin_answer`); when set, a Haiku call rephrases the admin's answer + the customer's question into a standalone, general instruction and inserts it into `chatbot_instructions` (same table `training-chat` writes to), then calls `invalidateCache()` so it's live within the settings cache's normal refresh. Opt-in by design (checkbox in `inbox-client.tsx`'s bot-reply preview panel, unchecked by default) — most bot-help answers are one-off/customer-specific and would pollute the system prompt if auto-saved every time.
- `16:00 +0700` Historical data re-import (`scripts/import-customers-orders.ts`): re-ran the customer/order/delivery import (`--until=2026-06-29`) then `--reconcile` against clean sheet names. Fixed 3 real bugs found along the way: (1) new `--until=YYYY-MM-DD` flag mirroring `--after`, so ORDER_HARIAN rows past the cutover aren't double-imported (post-cutover deliveries live only in app-entered `daily_deliveries`); (2) `--reconcile` now sums delivered portions from both ORDER_HARIAN (through the cutover) and `daily_deliveries` (after it), and skips overwriting any customer whose only post-cutover `orders` row already has a real, non-zero `package_size` (in-app entry wins over stale sheet data) — both guarded by named constants `SHEET_DELIVERY_CUTOVER`/`ORDER_AUTHORITY_CUTOVER`; (3) `normalizePackageRow`'s header matcher was missing the sheet's actual singular header `portion` (only matched `porsi`/`portions`), so every package purchase silently summed to 0 — every customer's computed remaining quota was wrong until this was caught by manually inspecting a dry run. Also found and fixed real data corruption: 11 rows in the CUSTOMERS sheet (Jocelyn, Grace, Reyhan, Onny, Kezia Wijaya, Sensen, Claire Lina, Berliana Chandra, Maria Marcella, Rowan, Felik Darmawan) had an identical copy-pasted `Sisa Kuota=152`/`Total=Rp4,023,000` placeholder, which the (pre-existing) customer-creation path took literally and inserted as real `orders` rows — deleted the 12 orphan ones, zeroed the one with real linked deliveries (Syifa's) so reconcile could recompute it correctly, then re-ran `--reconcile` for real (163 customers updated). Deleting those 12 left their customers with a correct `portions_remaining` on the `customers` row but no `orders` row at all (reconcile only updates existing orders, never creates them), so for the 11 underlying customers (2 had duplicate customer records) manually created one real `orders` row each straight from the package_orders sheet's actual purchase totals for that name (`package_size`/`price_per_portion`/`total_price` all sheet-derived, not the bogus placeholder) — all 11 had a genuine package_orders match, so the "no match → blank order" fallback was never needed in practice. Manually set Darren Dior's `linked_order_id` to Daryn Dior's oldest active order (standing family-sharing arrangement). Re-ran `scripts/audit-sheet-data.ts` afterward to confirm 0 unmatched names and the same 26 genuine negative-balance customers as an independent sheet-only cross-check.
- `03:30 +0700` Added: "Grant free quota" batch feature so admins can record goodwill/compensation portions (e.g. late-delivery makegoods) as discrete, auditable events instead of an unexplained balance deficit — replaces a rejected "detect grant via balance crossing zero" heuristic, which can't distinguish goodwill given while balance is still positive. New `orders.source`/`grant_reason`/`granted_by` columns (migration 055); new `POST /api/customers/free-quota` route inserts one Rp 0 `orders` row per grant (tagged `source: "free_quota"`) plus bumps `customers.portions_remaining`; the customer ledger (`GET /api/customers/[id]`) labels these rows `Kuota gratis: <reason>` so each grant shows as its own `+N` line. New "+ Grant free quota" button/modal on the Customers page (`customers-client.tsx`) — searchable customer combobox, batch entry (portions/date/reason per row), single Save submits the whole batch.
- `01:45 +0700` Fixed: `PATCH /api/orders` `mark_paid` action updated order status but never synced `customer_state.state`, so a customer whose payment was confirmed stayed forever at `awaiting_payment`. The bot's context (`buildSystemPrompt`) reads `customer_state.state`, so it kept asking already-paid customers to pay — reproduced live with Hanna (order active/paid since 2026-06-30, state stuck since 2026-07-03 while she asked about her delivery). Fix: `mark_paid` now also sets `customer_state.state = "active_subscription"` right after the order status update. Backfilled Hanna's stuck row manually. Also found: Hanna has a duplicate `customers` row (`+6285174104007` vs `6285174104007`, no leading `+`) — not touched, flagged as tech debt below.

## Recent updates (July 3, 2026)

- `23:22 +0700` Added a hallucination-prevention validator to the chatbot's reply pipeline (`processSavedCustomerMessage` in `POST /api/webhook/whatsapp`), after repeated real incidents of the bot stating customer-specific facts (quota, name, order status) not backed by DB context. New `validateReply()` (`src/lib/claude/validate-reply.ts`) is a Haiku 4.5 call (same JSON-in-prompt pattern as `photo-matcher.ts`) that checks the Sonnet reply against the same "Current context" fields passed into `buildSystemPrompt` (name, notes, quota, state) and flags unsupported customer-specific claims — general FAQ/pricing/menu claims are never flagged. On rejection, the bot regenerates once with a corrective instruction; if the regenerated reply also fails validation, the customer gets a fixed fallback template (`reply_validation_fallback`, migration 054) instead of the raw reply, `customer_flags.pending_bot_response` is set, and admins get a high-priority push so a human follows up. The validator fails open (treats as valid) on any network/parse error so a validator outage never becomes a chatbot outage. Regeneration/validator token usage is counted via the existing `updateTokenCount`. Known gap: address and payment status are not yet structured fields in `buildSystemPrompt`'s context, so the validator cannot catch hallucinations on those two fields today — would need those added to the system prompt first.

## Recent updates (July 2, 2026)

- `23:35 +0700` Fixed: escalated-customer push notifications (`sendPushToAllAdmins` call in `POST /api/webhook/whatsapp`) showed the raw phone number instead of the customer's name in the body text. Now uses `customer.name ?? message.from` — falls back to the number when the customer has no name yet (name is only populated once they place an order, see existing comment at `route.ts:192`).
- `21:38 +0700` Inbox thread list gains a search box (`inbox-client.tsx`): filters visible threads by customer name, phone number, or last message content, client-side, combined with the existing All/Unread/Unanswered tab filter.
- `18:33 +0700` Fixed: Orders page list API (`GET /api/orders`) silently broke after migration 052 added `customers.linked_order_id`, because PostgREST now sees two `orders ↔ customers` relationships and rejects bare `customers(...)` embeds as ambiguous (`PGRST201`). The Orders dashboard was calling this route with `status=active`, getting no usable data, and rendering an empty table. The fix was surgical: specify the intended FK explicitly as `customers!orders_customer_id_fkey(...)` in both the list query and the `mark_paid` fetch path inside `src/app/api/orders/route.ts`.
- `18:07 +0700` Fixed: `area_neighborhoods` had RLS disabled (flagged by Supabase dashboard). Migration 053 enables RLS with an `authenticated`-only policy, matching the pattern used by other admin-only tables. No app code changes needed — the table was already only accessed server-side via the admin (service-role) client. Also backfilled a missing DATABASE.md entry for the table (added in migration 050, never documented).
- `17:47 +0700` Fixed: `delivery_route` (used to auto-group the Daily Sheet into Route 1 / Route 2) was only ever computed on manual customer creation (`POST /api/customers`). The WhatsApp onboarding flow (`POST /api/webhook/whatsapp`) set `area`/`sub_area` on the customer record but never touched `delivery_route`, leaving it `null` (shown as "Unassigned route") even when the area was mappable — this is why Claire Lina (area `BSD Baru`) wasn't auto-assigned. The area→route map (`Alam Sutera`/`BSD Lama` → 1, `Gading Serpong`/`BSD Baru`/`Karawaci` → 2 — `Karawaci` was also missing before this fix) is now a single shared helper `getDeliveryRoute()` in `src/lib/utils/format.ts`, used by both write paths. Backfilled 2 existing customers (Claire Lina, Sky) whose `delivery_route` was stale.
- `17:38 +0700` Deliveries → Daily Sheet "+ Add customer" button is now icon-only (`Plus` from `lucide-react`), no text label. `title`/`aria-label="Add customer"` retained for accessibility.
- `17:33 +0700` Chatbot and admin assistant upgraded from Sonnet 4.6 to Sonnet 5 (`claude-sonnet-5`). Changed `SONNET_MODEL` fallback in `src/lib/claude/client.ts` plus `CLAUDE_SONNET_MODEL` in `.env.local`, `.env.example`, and Railway prod env. No sampling params (`temperature`/`top_p`/`top_k`) or `thinking` config in use, so no other code changes needed. Sonnet 5 uses a new tokenizer (~30% more tokens for same text) — intro pricing ($2/$10 per MTok through Aug 31, 2026) roughly offsets this, but token budgets in `safety.ts`/`conversation.ts` (4000 input / 1000 output / 3000 system prompt) should be re-verified against actual usage before Sep 1, 2026 when pricing reverts to $3/$15.
- `16:35 +0700` Fixed: WhatsApp location messages sent while `pending_bot_response` or `escalated_to_human` was set fell through to a generic `[${message.type}]` fallback, discarding lat/lng and showing literal `[location]` in the inbox. All three code paths (normal, pending, escalated) now share `formatLocationMessage()`, which saves a Google Maps link (`https://www.google.com/maps?q=lat,lng`) alongside the shared/named address text. Inbox chat bubbles now linkify any `http(s)://` URL in message content (`renderContentWithLinks()` in `inbox-client.tsx`), so the Maps link renders clickable. Messages saved before this fix keep their literal `[location]` text — the original coordinates were never persisted and can't be recovered.

## Recent updates (July 1, 2026)

- `19:48 +0700` Customers gain a `linked_order_id` field (migration 052): a customer can now draw daily portions from another customer's order/balance instead of their own — e.g. two kids both drawing from a dad's single package. Set once on the customer record (Customers page "Draws From Another Customer's Balance" dropdown, both add and edit forms); `GET /api/deliveries/addable-customers` resolves to the linked order automatically so admins don't pick an order per delivery. `GET /api/customers?all=true` now also returns each customer's own `active_order_id` to power the linking dropdown.
- `18:30 +0700` Deliveries → Daily Sheet date picker now remembers the last picked date (`localStorage` key `deliveries-last-date`) and defaults to it on page load, falling back to tomorrow if none saved.
- `17:57 +0700` System prompt contextual-reply rule now distinguishes post-delivery "ok" (responds with enjoy-food message) from generic affirmative "ok" (responds with "Ada yang bisa kami bantu?").
- `13:49 +0700` Webhook now saves caption-less customer images to `conversations` before sending the text-only reply. Previously these dropped silently and never appeared in the inbox.
- `16:18 +0700` Inbox assistant messages now persist WhatsApp `message_id` plus `whatsapp_status` / `whatsapp_status_updated_at`, and `POST /api/webhook/whatsapp` now applies Meta `sent` / `delivered` / `read` / `failed` status webhooks so the dashboard can show read receipts.
- `16:05 +0700` Inbox thread list now has `All`, `Unread`, and `Unanswered` filters. `Unread` follows the latest-message-is-customer heuristic, while `Unanswered` highlights threads with `customer_flags.pending_bot_response` or human takeover active.
- `15:32 +0700` Deliveries dashboard mobile sheet: widened the delivery-proof upload action cell and tightened the small-screen dapur select so the camera uploader no longer clips off-screen.
- `12:52 +0700` Deliveries dashboard: sent proof cards now have a resend action in the Proof of Delivery tab.
- `13:07 +0700` Inbox delivery-proof images now render through `GET /api/inbox/delivery-proofs/[...path]`, so private storage proofs display correctly in the dashboard thread.
- `14:09 +0700` Admin inbox now supports pipeline stage override via `POST /api/inbox/pipeline-stage`. Valid stages: `browsing`, `ordering`, `awaiting_payment`, `payment_proof_received`, `active_subscription`. Payment-related overrides also sync the latest order status when possible.
- `14:35 +0700` Manual text replies and manual image sends now clear `customer_flags.pending_bot_response`, so the thread does not stay stuck in "awaiting bot reply" after an admin handles it.
- `14:47 +0700` Human takeover now also clears `pending_bot_response` when an admin takes over a thread.
- `15:03 +0700` Admins can replay the latest saved customer text after unblocking a thread via `POST /api/inbox/replay-latest`. Replay is skipped for blacklisted customers, blocked threads, welcome-only threads, non-text latest messages, or empty content.
- Webhook/payment follow-up rule: `awaiting_payment` messages bypass the normal chatbot rate-limit gate so payment and proof-of-payment follow-up can continue even after a customer has hit the usual limit.

## Architectural principles

1. **HTTP 200 first, process after** — webhook returns 200 to Meta immediately, then processes async
2. **Idempotency everywhere** — every webhook event has a `message_id`, check against `processed_messages` table before processing
3. **Defense in depth** — 9 layers of cost protection (see "AI Cost Controls" section below)
4. **Settings over hardcoding** — anything that might change goes in the `settings` table, edited via UI
5. **Server-controlled fields** — `id`, `created_at`, `updated_at`, `status`, `total_price` are always set by server, never accepted from client input
6. **Allowlist field updates** — when updating records, explicitly list permitted fields; never use mass assignment
7. **Sensitive fields in separate tables** — rate limits, flags, internal status live in tables users cannot edit
8. **Audit log append-only** — `edit_log`, `processed_messages`, `conversation_logs` are insert-only, never updated or deleted

## Business rules

### Confidentiality (critical)

- **Never** disclose subcontractor names (Santapin, Thenie) to customers, in any form
- Frame as "dapur kami" (our kitchen) — implies internal operations
- Customer-facing error messages are always generic; never leak technical details
- Never reveal COGS, profit margins, or internal operations
- Bank account details only sent after order confirmation, never proactively

### Language & tone

- All customer-facing messages in Indonesian only
- Use "kak" as honorific
- Bot replies under 200 words always
- Use emojis sparingly but warmly
- 50% of conversational messages should be casual (lowercase, no punctuation, no emojis) to feel human; transactional messages (order summaries, bank details, payments) must always be polished

### Pricing

- Customer-facing chatbot prompt has the current Paket Personal S price list spelled out in `src/lib/claude/prompts/system.ts`; keep this in sync with `pricing_tiers` and `price_list_image_url`.
- Existing orders lock in `price_per_portion` at order creation time
- Current S-only customer price thresholds: 5=29k, 10=28k, 20=27k, 40=26k, 60=26k, 120=25k per portion.
- Current active subcontractor only serves 5 days/week. Chatbot must not offer 6 days/week as available, even though the public price list includes 6-day packages.
- Custom fixed-schedule day counts that are multiples of 5 use repeated 5-day blocks. Example: 15 days lunch-only = 3 × Rp 145k = Rp 435k. Non-multiples of 5 must be rejected politely; tell customers to choose a multiple of 5 days.
- Bulk adjust supported: `PATCH /api/settings/pricing` with `{ adjust: number }` increments all tiers at once

### Order sizes (S / M)

- Every order has a `size` column (`text`, default `'s'`, constraint `IN ('s', 'm')`) added in migration 043
- **S** = standard tier price, no surcharge
- **M** = historical/admin-only option. The current customer-facing chatbot must not ask S/M and must create webhook orders as `size: "s"` with no M surcharge.
- The surcharge is stored, never derived; editing `size` on a historical order does NOT recalculate `price_per_portion` or `total_price`
- Admin can change `size` on any order via the inline select in the Orders table — calls `PATCH /api/orders` with `{ action: "update_size", id, size }`, updates only the `size` column

### Delivery

- Areas: derived dynamically from active subcontractors' `delivery_areas` column — not stored in `settings`. Current active areas: BSD Baru, BSD Lama, Gading Serpong, Alam Sutera, Karawaci. Bintaro and Graha Raya are served by no active subcontractor.
- Order deadline: 8pm the day before delivery
- After 8pm cutoff, orders schedule for day after tomorrow
- Annie can manually override deadline with warning popup
- Two subcontractors handle delivery (Santapin, Thenie) — assigned manually by Annie per customer, never automated

### Order flow stages

`pending_payment` → `payment_proof_received` → `active` → `paused` (optional) → `completed`

Cancellations: `cancelled_unpaid`, `cancelled_by_customer`, `cancelled_by_admin`, `refunded`

### Meal time preference types

- `lunch_only`
- `dinner_only`
- `both_fixed` (e.g., 1 lunch + 1 dinner daily)
- `per_day_decision` (customer messages each day)
- `default_lunch` or `default_dinner` (default with ad-hoc overrides)
- `custom_schedule` (JSON with per-weekday preferences)

### Confidentiality flow for subcontractor issues

When subcontractor is unavailable, use template: "Halo kak, mohon maaf dapur kami yang biasanya besok libur, besok kita akan kirim dari dapur yang satunya lagi"

### Idempotency strategy

- Every incoming WhatsApp `message_id` is checked against `processed_messages` table before processing
- If exists, ignore and return 200
- If new, insert into `processed_messages` first, then process

### User roles

Two roles, stored in `admin_users.role`:

- `owner` — full access to all dashboard pages and APIs (Justin: drpramadyo@gmail.com, Annie: angelaoctaviani196@gmail.com)
- `admin` — full access except Accounting page/API (Agnes: agnesiaagatha2006@gmail.com)

New admins default to `admin` role. Role is enforced at two layers: nav item hidden in layout, and server-side redirect / HTTP 403 on the page and API route. Role helper: `src/lib/supabase/get-role.ts` exports `getSessionWithRole()` and `isOwner(role)`.

## AI cost controls (9 layers)

1. **Anthropic console budget cap** — $100/month hard limit, configured outside this codebase
2. **API key hygiene** — keys only in `.env` and Railway env vars, never committed
3. **Per-customer rate limits** — 20 bot replies/day, 7 bot replies/minute, 100,000 tokens/day per customer
4. **Token budget per request** — max 20 messages from history, max 4000 input tokens, max 1000 output tokens, max 3000 token system prompt
5. **Loop prevention** — idempotency, circuit breaker (stop calling Claude for 5min if 5 errors in 60s), echo detection (don't send duplicate replies), retry budget (max 3 retries per message)
6. **Prompt injection defense** — system prompt forbids long/repetitive responses, hard `max_tokens` cap, pattern detection before calling Claude
7. **Model routing** — Sonnet 5 only for full conversational responses; Haiku 4.5 for photo matching, classification, sentiment, and any preprocessing step
8. **Monitoring** — dashboard widgets for spend/tokens, push notifications on anomalies, daily 9am digest email
9. **Kill switch** — toggle in Settings to disable AI chatbot entirely

## Performance principles

- **Database indexes** on every column used in WHERE/JOIN/ORDER BY (especially `phone_number`, `message_id`, `status`, `created_at`)
- **Pagination** on all list endpoints, default 20 rows
- **`Promise.all`** for parallel queries when loading multiple datasets
- **TanStack Query** for client-side caching, optimistic updates, stale-while-revalidate
- **Skeleton loaders** for any data fetching, never blank screens
- **Settings/templates cached in-memory** on the server, refresh every 60s
- **Co-locate Railway and Supabase in Singapore region** for low latency

## Push notifications (web-push)

VAPID keys stored in env vars. Subscriptions stored in `push_subscriptions` table.

Priority levels:

- **High**: complaints, escalations, API errors, kill switch triggered, fraud/spam detected
- **Medium**: payment proof received, order modifications, large new orders, low-confidence photo matches
- **Low**: routine new orders, renewal reminders sent, daily delivery sheet ready (digest)

## Folder structure

```text
pian-yi/
├── CLAUDE.md (this file)
├── package.json (pnpm)
├── pnpm-lock.yaml
├── next.config.ts (output: 'standalone')
├── tailwind.config.ts
├── biome.json (Biome config)
├── tsconfig.json
├── .env.local (gitignored)
├── .env.example
├── .gitignore (includes .env*, node_modules, .next, .turbo)
├── README.md
├── supabase/
│   ├── config.toml
│   ├── migrations/ (SQL migrations managed by Supabase CLI)
│   └── seed.sql
├── src/
│   ├── app/
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx (auth-protected)
│   │   │   ├── page.tsx (dashboard home)
│   │   │   ├── inbox/
│   │   │   ├── customers/
│   │   │   ├── orders/
│   │   │   ├── deliveries/
│   │   │   ├── payments/
│   │   │   ├── subcontractors/
│   │   │   ├── chatbot-training/
│   │   │   ├── reports/
│   │   │   ├── settings/
│   │   │   └── assistant/
│   │   ├── (auth)/
│   │   │   ├── login/
│   │   │   └── callback/
│   │   └── api/
│   │       ├── webhook/
│   │       │   └── whatsapp/route.ts (Meta webhook)
│   │       ├── cron/
│   │       │   ├── send-reminders/route.ts
│   │       │   ├── cancel-unpaid/route.ts
│   │       │   ├── daily-summary/route.ts
│   │       │   └── lapsed-customers/route.ts
│   │       └── push/
│   │           └── subscribe/route.ts
│   ├── proxy.ts (Supabase SSR session refresh — Next.js 16 "proxy" convention, replaces middleware.ts)
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts (browser)
│   │   │   ├── server.ts (server)
│   │   │   ├── admin.ts (service role, server-only)
│   │   │   └── get-role.ts (getSessionWithRole + isOwner helpers)
│   │   ├── claude/
│   │   │   ├── client.ts
│   │   │   ├── conversation.ts (history management, token budget)
│   │   │   ├── prompts/
│   │   │   │   ├── system.ts (main chatbot prompt for Sonnet 5)
│   │   │   │   ├── classifier.ts (Haiku 4.5 classifier)
│   │   │   │   └── photo-matcher.ts (Haiku 4.5 photo matching)
│   │   │   └── safety.ts (rate limits, circuit breaker, echo detection)
│   │   ├── whatsapp/
│   │   │   ├── client.ts (send messages, typing indicators)
│   │   │   ├── webhook.ts (signature verification, message parsing)
│   │   │   └── types.ts
│   │   ├── push/
│   │   │   └── send.ts (web-push wrapper)
│   │   └── utils/
│   │       ├── delay.ts (dynamic typing delay)
│   │       └── format.ts (currency, dates)
│   ├── components/
│   │   ├── ui/ (shadcn components)
│   │   ├── dashboard/
│   │   └── shared/
│   └── types/
│       └── database.ts (generated by `supabase gen types`)
└── scripts/
    ├── seed.ts (initial settings/templates seed)
    ├── audit-sheet-data.ts (re-runnable data audit; scans CUSTOMERS/ORDER_HARIAN/package_orders sheets vs the DB customers table → writes DATA_AUDIT.md listing name mismatches (with "did you mean" suggestions), orphan purchases (package_orders rows with money/portions but blank name), blank-name deliveries, and zero/typo values. Run: `set -a && . ./.env.local && set +a && pnpm tsx scripts/audit-sheet-data.ts`)
    └── import-customers-orders.ts (re-runnable Google Sheets → Supabase import; fetches CSV directly via export URL, upserts customers by phone_number, skips orders for customers that already have active orders. Flags: `--skip-customers` (build name→id maps from DB, import deliveries only), `--after=YYYY-MM-DD` (only ORDER_HARIAN rows after date), `--reconcile` (recompute every customer's remaining quota = Σ package_orders.Porsi − Σ ORDER_HARIAN.Jumlah dated ≤ today; writes customers.portions_remaining/avg_price + the customer's oldest active order's package_size/portions_remaining/price/total; never touches status/customers/journals), `--dry-run` (with --reconcile: print per-customer pkg/delivered/remaining diff table + unmatched-name warnings, write nothing). Three sheet tabs on one spreadsheet: CUSTOMERS gid 1454452383, ORDER_HARIAN gid 1975392427, package_orders gid 341974326.)
```

## API Routes

Quick reference: which file handles which feature.

### Webhook (WhatsApp chatbot)
- `GET /api/webhook/whatsapp` — Meta webhook verification (hub.challenge handshake)
- `POST /api/webhook/whatsapp` — **Main chatbot entry point.** Dedup via `processed_messages`, rate-limit check, Sonnet 5 conversation, tools: `extract_order` / `record_daily_order` / `escalate_to_human` / `ask_admin_for_help`. Meta `statuses[]` webhooks are also handled here and update the matching `conversations.message_id` row with `whatsapp_status` / `whatsapp_status_updated_at` (`sent`, `delivered`, `read`, `failed`). After each inbound customer message is saved to `conversations`, Haiku auto-summarizes durable customer context via `src/lib/claude/learn-context.ts`, replaces the `[AI learned context]` block in `customers.notes`, and feeds the freshly learned notes into the same bot response when available; failures are logged and never block replying. Also handles welcome sequence: resolves `{{dapur_list}}`, `{{delivery_areas}}`, `{{price_20}}`, `{{order_deadline}}` placeholders in `welcome_message` setting from live DB data, then sends menu images from active subcontractor rows. The welcome greeting + price list image + each menu image are also logged to `conversations` as `assistant` rows (`model_used: "system"`, image rows use `message_type: "image"` with the URL as content) so they render in the dashboard inbox.

### Auth
- `POST /api/auth/check-admin` — Check if email exists in `admin_users`. ⚠️ Known issue: no session verification, allows unauthenticated email enumeration.
- `POST /api/auth/signout` — Sign out + redirect to `/login`

### Dashboard
- `GET /api/dashboard/metrics` — All KPI metrics in one call (active orders, revenue, deliveries, etc.)

### Orders
- `GET /api/orders` — List orders, optional `?status=` filter
- `POST /api/orders` — Admin creates a new order; accepts `size` (`"s"` | `"m"`, default `"s"`) and `lunch_address_slot` / `dinner_address_slot` (`1` | `2`, default `1`) — a standing per-meal delivery-address rule (slot 2 = the customer's `address_2`). Persisted on the order; the `generate-deliveries` cron and the scheduled-order delivery rows stamp each `daily_deliveries` row's `address_slot` from the matching meal's slot. A per-day flip on the daily sheet still overrides.
- `PATCH /api/orders` — Requires `{ id, action }`. Actions: `"mark_paid"` (sets status → active, records conversion, posts journal + WhatsApp confirmation); `"update_size"` (updates `size` column only, never recalculates price); `"update_fields"` (allowlisted operational columns only — `area, delivery_address, maps_link, subcontractor_id, meal_time_preference, end_date, size, lunch_address_slot, dinner_address_slot, portions_lunch, portions_dinner, portions_per_delivery`; never touches money/quota/status/server columns); `"update_status"` (safe side-effect-free transitions only — `paused`/`completed`/`cancelled_by_admin`, stamps `completed_at`/`cancelled_at`; rejects any other value incl. `active` so money-activation stays on the `mark_paid` path). The Orders table rows are clickable → a detail slide-over (`orders-client.tsx`) showing all order fields read-only, editing the operational set via `update_fields`, a Mark-Paid button (pending orders → `mark_paid`), and a status dropdown (→ `update_status`).

### Customers
- `GET /api/customers` — List customers who have at least one paid order (status `payment_proof_received`/`active`/`paused`/`completed`); leads and unpaid/cancelled do not surface. `?all=true` returns every customer (used by the new-order modal so an admin can start the first order for a just-created, order-less customer) plus each customer's own `active_order_id` (their own active/paused order, if any — used to power the "draws from another customer" linking dropdown).
- `POST /api/customers` — Create a customer (e.g. someone who ordered a package manually via WhatsApp and isn't onboarded yet). Allowlisted fields only (`name, phone_number, area, sub_area, address, address_2, google_maps_link, subcontractor_id, linked_order_id`); `phone_number` and `address` (primary address) are required, `address_2` (secondary address) is optional; `phone_number` must be unique (duplicate → 409 with `existingId`). Used by the "+ Add customer" form on the Customers page and the inline "+ Buat pelanggan baru" creation in the new-order modal.
- `PATCH /api/customers/[id]` — Update `name`, `notes`, or `linked_order_id` (allowlisted). Setting `linked_order_id` makes this customer's daily draws come from another customer's order instead of their own.
- `DELETE /api/customers/[id]` — Delete customer: detaches payment proofs, removes conversation state and rate limit records
- `PATCH /api/customers/reorder` — Bulk-update `delivery_position` for multiple customers; body: `{ updates: [{ id, delivery_position }] }`
- `POST /api/customers/free-quota` — Batch-grant free/goodwill portions (e.g. compensation for a late delivery). Requires `owner` or `admin` role. Body: `{ grants: [{ customer_id, portions, date, reason }] }`. Each grant inserts its own `orders` row (`source: "free_quota"`, `price_per_portion: 0`, `total_price: 0`, `package_size`/`portions_remaining`/`portions_per_delivery`: portions, `grant_reason`, `granted_by`: admin email) so it shows as a discrete `+N` "Kuota gratis" line in that customer's ledger, and bumps `customers.portions_remaining` by the same amount. No accounting journal is posted (Rp 0 double-entry would be degenerate). Writes one `edit_log` row (`action: "grant_free_quota"`) per batch. Used by the "+ Grant free quota" button/modal on the Customers page.

Conversion tracking columns on `customers` (migration 042): `ad_creative` (e.g. `"C4"`, auto-detected from first WhatsApp message), `first_message`, `converted_at` (set on first `mark_paid`), `package`, `total_portions`, `total_payment`, `promo_used` (manual), `converted_to_subscription` (boolean), `notes`. All editable via the customer detail panel.

Second address columns on `customers` (migration 044): `address_2`, `area_2`, `sub_area_2`, `google_maps_link_2`. Linked to `daily_deliveries.address_slot` (1 = primary, 2 = secondary, default 1).

Standing per-meal address rule on `orders` (migration 048): `lunch_address_slot`, `dinner_address_slot` (`smallint`, `IN (1, 2)`, default 1). Set in the new-order modal (toggles shown only when the customer has `address_2`). The `generate-deliveries` cron stamps each generated `daily_deliveries` row's `address_slot` from the matching meal's order slot, and scheduled orders stamp their rows at creation. A per-day flip on the daily sheet still overrides for a single day.

### Deliveries
- `GET /api/deliveries/daily-sheet` — Fetch delivery rows for a given date
- `POST /api/deliveries/daily-sheet` — Create daily delivery rows for a date
- `PUT /api/deliveries/daily-sheet` — Save edited rows for a date (upsert `daily_deliveries`, post revenue/COGS journals per non-skipped row; quota deduction handled by the nightly cron). Every row links an `order_id` (a draw always comes from a package).
- `GET /api/deliveries/addable-customers` — List customers Agnes can manually add to a daily sheet (a customer who decided to draw extra from their package for a date but has no auto-generated row). A draw always comes from a package — customers cannot buy a fresh one-off — so only customers with an active recurring order **(own, or resolved via `customers.linked_order_id` to someone else's)** are returned, each with the address/route fields the sheet renders plus their `active_order`. The Deliveries → Daily Sheet tab has an "Add customer" button → modal (searchable customer combobox, meal type, portions, dapur) that appends a `daily_deliveries` row (linked to the active order's `order_id`) to local state; admin clicks Save to persist (nightly cron deducts quota, save posts journals).
- `GET /api/deliveries/proofs` — List payment proof photos with signed URLs
- `POST /api/deliveries/proofs` — Upload proof photo (admin upload); stamps `received_at` to the admin-selected delivery date so it lands on the right day, inserts with `status: "admin_uploaded"` and `matched_customer_id`; surfaces in the "Ready to send" section of the Proof of Delivery tab.

### Inbox (admin-guided bot responses)
- Dashboard inbox thread list supports three client-side filters: `All`, `Unread`, and `Unanswered`. `Unread` means the latest conversation row is a customer (`role: "user"`) message; `Unanswered` means `customer_flags.pending_bot_response = true` or `customer_flags.escalated_to_human = true`.
- Assistant/inbox outbound rows now persist Meta’s returned `message_id` and start at `whatsapp_status = "sent"` so the UI can later show `Sent`, `Delivered`, or `Read` from webhook updates.
- `POST /api/inbox/bot-reply` — Admin provides a concise answer → Haiku polishes it → bot sends polished message to customer → clears `pending_bot_response` flag. Optional `save_as_rule: true` also rephrases the answer into a general instruction and inserts it into `chatbot_instructions` so future customers get it automatically (opt-in checkbox in the inbox UI).
- `GET /api/inbox/delivery-proofs/[...path]` — Auth-gated proxy for proof images stored in Supabase Storage; used by the inbox UI so proof attachments render without exposing the storage bucket directly.
- `POST /api/inbox/learn-context` — Manual fallback for the same learned-context summarizer used by the webhook auto-learn path. Requires admin auth and `{ customer_id }`; writes only the `[AI learned context]` block in `customers.notes`.
- `POST /api/inbox/pipeline-stage` — Admin override for the customer pipeline stage. Updates `customer_state.state`; payment-related stages also reconcile the latest order status (`pending_payment`, `payment_proof_received`, `active`) when an order exists.
- `POST /api/inbox/replay-latest` — Re-run the latest saved inbound customer text through the normal chatbot flow after a thread is unblocked. Requires auth and `{ customer_id }`.

### Settings
- `GET /api/settings` — All settings + pricing tiers + message templates + admin list
- `PATCH /api/settings` — Update a single settings key (e.g. `{ key: "order_deadline_hour", value: "20" }`)
- `POST /api/settings/admins` — Add admin user + create Supabase Auth account; body: `{ email, role? }` (`role` defaults to `"admin"`)
- `PATCH /api/settings/admins` — Change an existing admin's role; body: `{ email, role }` (`"owner"` or `"admin"`); audit-logged
- `DELETE /api/settings/admins` — Remove admin user and their Supabase Auth account
- `POST /api/settings/menu-image` — Upload price list image (`price_list_image_url` only; dapur menu images are managed per subcontractor)
- `PATCH /api/settings/pricing` — Update a single pricing tier, or bulk-adjust all tiers with `{ adjust: number }`
- `PATCH /api/settings/templates` — Update a message template by key

### Subcontractors
- `GET /api/subcontractors` — List all subcontractors with off days
- `POST /api/subcontractors` — Create a new subcontractor
- `PATCH /api/subcontractors/[id]` — Update allowlisted fields (name, nickname, phone, areas, notes, cost, menu_text, etc.)
- `POST /api/subcontractors/[id]/menu-image` — Upload menu image to `menu-images` bucket → save URL to subcontractor row
- `GET /api/subcontractors/[id]/daily-sheet` — **Dapur Sheet** API: public (no auth), returns tomorrow's `daily_deliveries` for this subcontractor with lunch/dinner × rute1/rute2 summary. Supports `?date=YYYY-MM-DD`. Respects `address_slot` so slot-2 customers show their secondary address.
- `POST /api/subcontractors/off-days` — Add an off day for a subcontractor
- `DELETE /api/subcontractors/off-days` — Remove an off day

### Dapur Sheet
A public, auth-free mobile page at `/dapur/[subcontractor-uuid]` shared with each subcontractor so they can see tomorrow's delivery orders without a dashboard login. Shows a lunch/dinner × Rute 1 (diantar Pian Yi) / Rute 2 (diantar subcontractor) portion summary, then per-order cards with name, area, sub_area, address (slot-aware), Maps link, notes, and portions. Supports `?date=YYYY-MM-DD` for non-default dates. Thenie's link: `/dapur/52cd5e62-da09-49c9-939c-2f1246566c40`.

### Chatbot training
- `POST /api/training-chat` — Annie chats with Sonnet to craft system instructions; auto-saves on `[SAVE_INSTRUCTION]` marker in response

### Broadcasts
- `GET /api/broadcasts` — List broadcasts with recipient counts
- `POST /api/broadcasts/preview` — Haiku parses natural-language instruction → returns filter criteria + personalized message previews
- `POST /api/broadcasts/send` — Send personalized WhatsApp messages to filtered customers

### Reports
- `GET /api/reports` — Revenue, orders, customers, churn analytics for N days
- `GET /api/reports/conversions` — Meta Ads conversion tracking: summary stats (total, this month, revenue, top creative, organic), per-creative breakdown, paginated conversion log. Supports `?startDate=`, `?endDate=`, `?page=`, `?export=true` (returns all rows for CSV download)

### Admin Assistant
- `POST /api/assistant` — Multi-turn agentic chat using Sonnet 5. Runs tool loop (max 5 turns) with read tools: `query_customers`, `query_orders`, `query_deliveries`, `query_financials`, `query_metrics`, `search_conversations`, `query_menu_assets`. Write tools (`mark_order_paid`, `cancel_order`, `send_whatsapp_message`, `send_whatsapp_image`, `update_customer_field`) are intercepted — returns `{ ok: true, text, pendingAction }` instead of executing. If Claude proposes multiple WhatsApp send actions in one response (for example menu image + price list image), the route returns one `pendingAction` with `tool: "batch"` and an `actions` array so the admin confirms once and every send is preserved. Body accepts optional `conversationId`; if absent, a new thread is created lazily and returned. Each turn (user msg + reply) is persisted to `assistant_conversations` / `assistant_messages` (shared across all admins). Requires auth.
- `POST /api/assistant/execute` — Execute a confirmed write-tool action. Body: `{ tool, input, conversationId? }`. Accepts tools in `WRITE_TOOLS` plus `tool: "batch"` for multiple confirmed WhatsApp sends. `mark_order_paid` side effects: sets status → active, conversion tracking, journal entry (Dr Bank BCA / Cr Uang Muka), WhatsApp confirmation to customer. `send_whatsapp_message` sends text via WhatsApp, then looks up the customer by `phone_number` and logs the message to `conversations` as an `assistant` row (`model_used: "human"`) so it appears in the dashboard inbox. `send_whatsapp_image` downloads the public image URL, uploads the binary to Meta with `uploadMediaToMeta`, sends by `sendImageMessageById` (not by `image.link`, which can fail silently), then logs the public URL to `conversations` as an `assistant` image row (`message_type: "image"`, `model_used: "human"`). `update_customer_field` allowlist: name, address, area, notes. Confirmation reply persisted to the thread when `conversationId` is provided. Requires auth.
- `GET /api/assistant/conversations` — List all chat threads (`id, title, updated_at`), newest first.
- `POST /api/assistant/conversations` — Create an empty thread, returns `{ id }`.
- `GET /api/assistant/conversations/[id]` — List messages for a thread.
- `PATCH /api/assistant/conversations/[id]` — Rename a thread (body `{ title }`).
- `DELETE /api/assistant/conversations/[id]` — Delete a thread (cascades to messages).

### Accounting
- `GET /api/accounting` — Paginated journal entries with optional date range filter
- `POST /api/accounting` — Owner-only. Create a manual balanced journal entry. Body: `{ date (YYYY-MM-DD), description, lines: [{ accountCode, debit, credit }] }`. Validates each line is debit XOR credit, total debit = total credit (> 0), and every `accountCode` exists. Inserts a `journals` header (`source_type: "manual"`, `source_id: null`) with an atomic `next_journal_reference` reference, then `journal_lines`; rolls back the header if line insert fails.
- `GET /api/accounting/accounts` — Owner-only. Active chart of accounts (`code, name, type`) for the manual-journal form dropdown. With `?all=true` returns every account incl. inactive with full fields (`id, code, name, type, normal_balance, category, is_active`) for the Akun management tab.
- `POST /api/accounting/accounts` — Owner-only. Create a chart-of-accounts entry. Body: `{ code (3–5 digits, unique), name, type (Asset|Liability|Equity|Revenue|Expense), category }`. `normal_balance` is derived server-side (Asset/Expense → Debit, else Credit), never accepted from client. Rejects duplicate code.
- `PATCH /api/accounting/accounts/[id]` — Owner-only. Edit `name`, `category`, or toggle `is_active`. `code`/`type`/`normal_balance` are immutable once created (locked to protect historical postings). Accounts are never deleted (referenced by `journal_lines`); deactivate hides them from the journal dropdown.
- `GET /api/accounting/reports?type=&from=&to=` — Owner-only. Server-computed financial statements from `journal_lines`. `type=trial_balance` (each account netted onto its normal side, `from` optional, cumulative through `to`); `type=pnl` (revenue − expense over `from..to`, returns `netIncome`); `type=balance_sheet` (assets / liabilities / equity cumulative through `to`, with cumulative revenue−expense folded into equity as a "Laba ditahan & berjalan" line, plus `balanced` flag).
- `GET /api/accounting/ledger?account=<code>&from=&to=` — Owner-only. Per-account general ledger: opening balance (net of lines before `from`), every line in range with a running balance on the account's normal side, and closing balance.

### WhatsApp (manual send)
- `POST /api/whatsapp/send` — Admin sends a manual text message from the dashboard UI

### Push notifications
- `GET /api/push/config` — VAPID public key + current subscription status
- `POST /api/push/subscribe` — Save a push subscription for this browser
- `POST /api/push/test` — Send a test push notification to this browser

### Health
- `GET /api/health` — Liveness probe (returns 200 OK)

### Cron (all require `CRON_SECRET` header)
- `GET /api/cron/auto-resume-bot` — Resume chatbot for escalated customers whose admin has been inactive > 15 min (checks `last_human_activity_at`)
- `GET /api/cron/abandoned-recovery` — Re-message customers stuck in ordering state with no completed order
- `POST /api/cron/cancel-unpaid` — Cancel orders that remain unpaid after N hours; notify customer
- `POST /api/cron/daily-summary` — Push notification with yesterday's metrics (runs at 9am)
- `GET /api/cron/generate-deliveries` — Pre-create `daily_deliveries` rows for tomorrow
- `GET /api/cron/lapsed-customers` — Detect customers who haven't ordered recently; send re-engagement message
- `GET /api/cron/post-delivery-followup` — Send satisfaction follow-up WhatsApp message after delivery
- `GET /api/cron/renewal-reminders` — Warn quota customers whose balance is running low
- `POST /api/cron/send-reminders` — Send payment reminder to customers with unpaid orders

## Coding conventions

- TypeScript strict mode on
- Server Components by default in Next.js App Router; mark client components with `'use client'`
- Database operations only via Supabase clients (browser client for user-scoped, admin client for server-only)
- All API routes return JSON with consistent shape: `{ ok: boolean, data?: any, error?: string }`
- Webhook routes always return 200, even on internal errors
- All async operations wrapped in try/catch with logging
- No hardcoded strings for user-facing messages — use templates from database
- Currency stored as integers in IDR (Rp 26.000 = `26000`)
- Dates stored as ISO strings; phone numbers as strings (preserve leading zero in display, store as international format `+628...`)
- All commits go through `gh` CLI; PR descriptions written via `gh pr create`
- Formatting enforced by Biome on save and in CI
- After making any code or documentation change, commit and push the completed change to `origin/main`. Stage only files relevant to the change; leave unrelated dirty worktree files untouched.

## Tooling commands

Standard commands (always use these spellings):

- Install: `pnpm install`
- Add dep: `pnpm add <pkg>`
- Add dev dep: `pnpm add -D <pkg>`
- Run script: `pnpm <script>`
- Dev server: `pnpm dev`
- Build: `pnpm build`
- Lint: `pnpm lint` (Biome linter, rules only)
- Lint autofix: `pnpm lint:fix` (applies safe lint-rule fixes)
- Check: `pnpm check` (Biome `check` — formatter + linter + imports; the full gate)
- Check autofix: `pnpm check:fix` (applies safe lint + format + import fixes)
- Format: `pnpm format` (Biome `format --write`, applies fixes)
- Type-check: `pnpm typecheck`
- Supabase types: `pnpm supabase gen types typescript --linked > src/types/database.ts`
- Supabase migrate (local): `pnpm supabase db reset`
- Supabase push (remote): `pnpm supabase db push`
- GitHub: use `gh repo`, `gh pr`, `gh secret set`, `gh workflow` for all repo operations
- Run tests: `pnpm test`
- Run tests in watch mode: `pnpm test:watch`
- Run tests with coverage: `pnpm test:coverage`

## Automated tests

Jest suite in `test/`. Uses `next/jest`, `testEnvironment: "node"`, `jest.mock()` for all externals (Supabase, Claude, WhatsApp). No real network calls.

Suites: `webhook`, `orders`, `orders-post`, `customers-delete`, `customers-post`, `inbox`, `assistant`, `assistant-execute`, `assistant-history`, `delivery-proofs`, `accounting`, `accounting-accounts`, `accounting-reports`, `addable-customers`, `settings`.

Pre-push hook (`.git/hooks/pre-push`): `pnpm lint && pnpm typecheck && pnpm test` — blocks on any failure.

When adding new API routes or webhook code paths, add a corresponding test in `test/`.

## Testing & deployment notes

- Local dev: Supabase CLI local stack (`pnpm supabase start`) OR a dedicated staging Supabase project
- Production deployment: Railway via GitHub auto-deploy on push to `main`
- Environment variables required (see `.env.example`)
- Webhook URL after deploy: `https://[railway-app].up.railway.app/api/webhook/whatsapp`
- Cron jobs configured via Railway's cron feature, hitting `/api/cron/*` endpoints with `CRON_SECRET` header verification
- Repo created and managed via GitHub CLI
- `next.config.ts` sets `serverActions.allowedOrigins: ["*.up.railway.app", "*.railway.app"]` — required to prevent Railway's reverse proxy from triggering Next.js CSRF rejection

## Things to never do

- Never use `npm`, `yarn`, or `bun` — pnpm only
- Never use ESLint or Prettier — Biome only
- Never upgrade or downgrade Next.js away from 16.2.6 without explicit instruction
- Never log API keys, tokens, or passwords (use `[REDACTED]` in logs)
- Never include `data_localization_region` in WhatsApp registration (deprecated in v21+)
- Never call Claude without checking rate limits first
- Never accept user input directly into update queries (use explicit field allowlist)
- Never mention subcontractor names in customer-facing strings
- Never delete from `processed_messages`, `edit_log`, or `conversation_logs` tables
- Never disable RLS on Supabase tables in production
- Never deploy this project to Vercel — Railway only
- Never create `middleware.ts` — Next.js 16 uses `proxy.ts` with `export function proxy()` (or default export)

## Known issues / tech debt

- `/api/auth/check-admin` — no session verification, allows unauthenticated admin email enumeration. Fix: extract email from verified Supabase session instead.
- `supabase/seed.sql` may still reference old `"BSD"` area string (not yet split into BSD Baru / BSD Lama).
- **Delivery proof auto-send (TODO):** call `sendDeliveryPhotoToCustomer(proofId, customerId)` directly in the POST route instead of the current "Ready to send" UI step.
- **Accounting Phase 4 (TODO):** "Balik jurnal" reverse-entry action — post mirror entry (swap debit/credit), link via `reversed_journal_id` on `journals`. `source_type: "manual"` only; auto-posted entries stay locked.
- **Accounting Phase 5 (TODO):** CSV export for journals/ledger (`?export=true`) + quick-expense form (auto-build 2-line balanced journal from account + amount).
- **Domain naming refactor (deferred, big):** `order` = prepaid package everywhere; daily portion-draw has no clean name. Preferred fix **(A)**: add `drawdown` as the daily-draw layer name, all existing `order` refs stay. High-risk fix **(B)**: rename package → `package_order`, daily draw → `order` — huge blast radius across tables, routes, tools, chat, accounting descriptions.
- **Duplicate customer rows from phone number format drift:** at least one pair found (Hanna: `+6285174104007` vs `6285174104007`) — same person, two `customers` rows, only one with real order/notes history. `phone_number` has no normalization or uniqueness constraint across `+` prefix variants. No dedup sweep run yet; `POST /api/customers` only checks exact-string uniqueness so it wouldn't have caught this.
