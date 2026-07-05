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
- **REQUIRED before every commit, no exceptions:** Update root `CLAUDE.md` — edit the specific section the change affects (tech stack, business rules, API routes, known issues, etc.), never a dated changelog entry — and root `DATABASE.md` (if schema changed) in the same commit as the code change. Never commit code without updating these files. If you skipped this, make a follow-up commit immediately.
- A git hook bumps the app version on every commit and amends the commit, so pushes often need a second attempt using the new HEAD SHA.

When performing infrastructure work, prefer CLI calls over manual UI clicks so the actions are reproducible and auditable.

**Budget note:** Justin on $20/month Claude Pro plan — limited usage cap. Avoid spawning Agent/subagents for bounded, known-target tasks (single file, known symbol); do those inline w/ Read/Edit/Bash/Grep. Reserve Agent for genuinely open-ended multi-file research or when explicitly requested.

## Architectural principles

1. **HTTP 200 first, process after** — webhook returns 200 to Meta immediately, then processes async
2. **Idempotency everywhere** — every webhook event has a `message_id`, check against `processed_messages` table before processing
3. **Defense in depth** — 9 layers of cost protection (see "AI cost controls" in `DEV_REFERENCE.md`)
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
- Contextual "ok" handling: post-delivery "ok" gets an enjoy-food reply; a generic affirmative "ok" gets a closing thanks only ("Baik kak, terima kasih ya 😊") — bot must not ask "Ada yang bisa kami bantu lagi?"

### Pricing

- Customer-facing chatbot prompt has the current Paket Personal S price list spelled out in `src/lib/claude/prompts/system.ts`; keep this in sync with `pricing_tiers` and `price_list_image_url`.
- Existing orders lock in `price_per_portion` at order creation time
- The admin inbox "Review extracted order" modal now shows server-computed `price_per_portion` and `total_price` before confirmation, but those values remain server-authoritative and are recomputed again on create.
- Manual inbox extraction now reads a deeper chat window (60 messages instead of 20) and includes saved learned-context notes in the prompt, so extraction still works after later back-and-forth pushes the original order form out of the most recent messages.
- Anthropic forced-tool extraction rejects conversations that end on an assistant turn; the inbox extraction path trims trailing assistant messages before calling Sonnet so old closed threads can still be parsed.
- The inbox extracted-order review modal supports two admin confirm modes: create the `pending_payment` order only, or create it and immediately send the payment-details WhatsApp message. The shared helper defaults to sending payment info unless the caller explicitly disables it.
- Manual order extraction now normalizes `package_size` to total portions when the chat clearly states a formula like `2 porsi x 5 hari = 10 porsi`, so the review modal prices recurring multi-portion orders correctly instead of treating day-count or per-delivery portions as the package size.
- Current S-only customer price thresholds: 5=29k, 10=28k, 20=27k, 40=26k, 60=26k, 120=25k per portion.
- Current active subcontractor only serves 5 days/week. Chatbot must not offer 6 days/week as available, even though the public price list includes 6-day packages.
- Splitting a fixed-schedule package's deliveries across two addresses on different days (e.g. 5 hari to address A, 1 extra day to address B) is operationally supported via the per-day address override on the daily sheet, but the extra day must not be folded into a 6-hari package (still unavailable). There is no single-portion one-off order — bebas/quota packages only sell in fixed sizes (5, 10, 20, 40, 60, 120 portions). Chatbot offers 5 hari paket tetap to address A as normal; the extra day's delivery to address B must draw from a bebas/quota package (min. 5 portions) the customer buys separately.
- Custom fixed-schedule day counts that are multiples of 5 use repeated 5-day blocks. Example: 15 days lunch-only = 3 × Rp 145k = Rp 435k. Non-multiples of 5 must be rejected politely; tell customers to choose a multiple of 5 days.
- Bulk adjust supported: `PATCH /api/settings/pricing` with `{ adjust: number }` increments all tiers at once
- Bebas/quota package sizes offered by the chatbot: 5, 10, 20, 40, 60, 120 total portions only (72 and 144 removed — see `PRICE_LIST_LINES` / the "Yang tersedia" prompt text in `system.ts`). The 72-hari fixed-schedule price rows are unrelated day-count pricing, not bebas packages.

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
- `delivery_route` (groups the Daily Sheet into Route 1 / Route 2) is computed via a single shared helper, `getDeliveryRoute()` in `src/lib/utils/format.ts` (area→route map: Alam Sutera/BSD Lama → 1, Gading Serpong/BSD Baru/Karawaci → 2), used on both write paths that can set a customer's area — manual customer creation and WhatsApp onboarding

### Order flow stages

`pending_payment` → `payment_proof_received` → `active` → `paused` (optional) → `completed`

Cancellations: `cancelled_unpaid`, `cancelled_by_customer`, `cancelled_by_admin`, `refunded`

`orders.status` is the source of truth for payment/subscription/order lifecycle as soon as an order row exists. `customer_state` is customer-level only (`new`, `ordering`, `lapsed`, `churned`) and should not mirror payment stages.

Payments page owns the payment queue: Awaiting payment lists `pending_payment`, admins can manually advance those rows to `payment_proof_received`, and Pending verification is where they run `mark_paid`.

Orders page status dropdown defaults to "Active" and has no unfiltered view by default — an explicit "All" option (empty status, no `.eq` filter applied) was added alongside the per-status options so admins can see orders in any stage.

### Meal time preference types

- `lunch_only`
- `dinner_only`
- `both_fixed` (e.g., 1 lunch + 1 dinner daily)
- `per_day_decision` (customer messages each day)
- `default_lunch` or `default_dinner` (default with ad-hoc overrides)
- `custom_schedule` (JSON with per-weekday preferences)

### Ordering flow (chatbot)

- Q0 (jadwal tetap vs pesan bebas) is skipped, not just when the customer's own message makes the model obvious, but also when: the customer has an active quota-based order (`activeOrder` present → model is already bebas/quota), or they're a known returning customer whose notes/history reveal a prior ordering model. Skip the walkthrough and infer from context instead of asking — this is a hard rule, not a hedge.
- Fixed-schedule ordering asks days / meal-preference / portions-per-delivery / kitchen as one combined message instead of one-at-a-time, to cut WA round-trips. The bot re-asks only whichever field the customer didn't answer.
- Relative date phrases ("senin depan", "besok", "lusa") must resolve to the nearest upcoming occurrence from Today, not one cycle further out; an explicit date the customer states later always overrides the bot's earlier interpretation of a relative phrase — the bot must never silently "correct" a date the customer already confirmed.

### Confidentiality flow for subcontractor issues

When subcontractor is unavailable, use template: "Halo kak, mohon maaf dapur kami yang biasanya besok libur, besok kita akan kirim dari dapur yang satunya lagi"

### Idempotency strategy

- Every incoming WhatsApp `message_id` is checked against `processed_messages` table before processing
- A `select` pre-check is a cheap fast-path, not the guard — Meta redelivers events within milliseconds and two concurrent requests can both pass the `select` before either write lands
- The real atomic guard is the `insert` itself (`message_id` is the table's primary key): its error must always be checked and treated as "another request already claimed this message_id" before proceeding to call Sonnet or send a reply

### User roles

Two roles, stored in `admin_users.role`:

- `owner` — full access to all dashboard pages and APIs (Justin: drpramadyo@gmail.com, Annie: angelaoctaviani196@gmail.com)
- `admin` — full access except Accounting page/API (Agnes: agnesiaagatha2006@gmail.com)

New admins default to `admin` role. Role is enforced at two layers: nav item hidden in layout, and server-side redirect / HTTP 403 on the page and API route. Role helper: `src/lib/supabase/get-role.ts` exports `getSessionWithRole()` and `isOwner(role)`.

## Dev reference

AI cost controls, performance principles, push notification priorities, full folder structure tree, tooling commands, automated tests, and testing/deployment notes moved to `DEV_REFERENCE.md` (read on demand, not loaded every session).

## API Routes

Full endpoint-level reference moved to `API_ROUTES.md` (read on demand when working on API routes, not loaded every session).

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
- **Fixed 2026-07-05:** migration 052 added `customers.linked_order_id → orders(id)`, a second FK between `orders`/`customers`. Any Supabase JS embed of `customers(...)` from an `orders`-rooted query became ambiguous (`PGRST201`) and needs an explicit hint: `customers!orders_customer_id_fkey(...)`. Fixed 7 call sites (payments-client, inbox-client, assistant/execute x2, cron/generate-deliveries, assistant-tools x3) — some silently swallowed the error and returned empty results instead of throwing. Known fallout: `daily_deliveries` has **zero rows for 2026-07-04 and 2026-07-05** (cron silently no-op'd); left un-backfilled per owner decision. Any other unqualified `orders`-rooted `customers(...)` embed added in future must use the explicit FK hint.
- **Fixed 2026-07-05:** `cron/generate-deliveries` had a blanket "skip entire date if any `daily_deliveries` row already exists" pre-check — meant to guard against double-runs, but it meant any order created/paid *after* the first run on a given day would never get its row generated for that date (the per-row `upsert` with `onConflict` already provides correct idempotency, so the pre-check was redundant and actively harmful). Removed the pre-check; generation now always runs and upserts are naturally deduped per `(delivery_date, customer_id, meal_type)`.
- **Fixed 2026-07-05:** `mark_paid` no longer generates only "today's" delivery row. For fixed recurring orders (`lunch_only`, `dinner_only`, `both_fixed`, `default_lunch`, `default_dinner`), both dashboard `PATCH /api/orders` and assistant `mark_order_paid` now pre-create the full `daily_deliveries` schedule immediately on payment using the order's date range when present, or by walking weekday slots from `start_date` until the package portions are exhausted. Flexible preferences (`per_day_decision`, `custom_schedule`) still do not auto-expand here.
- **Fixed 2026-07-05:** payment/subscription state is no longer mirrored into `customer_state`. Once an order exists, `orders.status` is authoritative for `pending_payment` / `payment_proof_received` / `active` / `paused` / `completed`; `customer_state` is slimmed to customer-level funnel/lifecycle only (`new`, `ordering`, `lapsed`, `churned`). Webhook payment-proof handling now keys off the latest order being `pending_payment`, Customers-page badges derive from latest order status when present, and quota exhaustion now stamps `completed_at` when an order is auto-completed.
- **Fixed 2026-07-05:** `orders.area` / `orders.delivery_address` / `orders.maps_link` duplicated `customers.area` / `address` / `google_maps_link` and could drift out of sync — root cause of a manually-created order (Lina Marlianty) showing "Unassigned route" because `customers.delivery_route` was only recomputed on specific write paths. Migration 056 drops all three columns from `orders`; address/area is customer-level data (rarely changes — a move goes in `address_2`, not a new order-level snapshot). Order pages/APIs now read delivery area/address live via join on `customers` instead of storing their own copy. `price_per_portion`/`total_price` are unaffected — those remain legitimately order-level (locked at order creation).
