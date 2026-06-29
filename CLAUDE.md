<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Pian Yi Catering — Project Context

This file is read at the start of every Claude Code session. It contains permanent context, conventions, and rules for the project.

## What this project is

A WhatsApp-based ordering system for Pian Yi Catering, a daily catering business serving BSD City, Gading Serpong, Alam Sutera, Bintaro, and Graha Raya in Tangerang Selatan, Indonesia.

Two end users:

- **Customers** — interact only via WhatsApp with an AI chatbot powered by Claude Sonnet 4.6
- **Admins** (Justin, Annie, Agnes) — interact via a PWA dashboard for operations; Justin and Annie are `owner` role, Agnes is `admin` role (see "User roles" section)

## Tech stack

- **Framework**: **Next.js 16.2.6 exclusively** (App Router) with TypeScript. Do not upgrade or downgrade.
- **Package manager**: **pnpm exclusively**. Never use npm, yarn, or bun. All scripts, install commands, and lockfiles must be pnpm.
- **Linter / formatter**: **Biome exclusively**. Do not use ESLint or Prettier.
- **Hosting**: Railway (always-on Node.js, `output: 'standalone'` mode, NOT serverless)
- **Database**: Supabase (PostgreSQL) with Row Level Security
- **Auth**: Supabase Auth (magic link email login for admins only)
- **AI**:
  - **Sonnet 4.6** (`claude-sonnet-4-6`) for normal tasks (customer chat, order conversations, training mode)
  - **Haiku 4.5** (`claude-haiku-4-5`) for lighter tasks (photo matching, classification, sentiment analysis, simple FAQ routing)
- **Messaging**: Meta WhatsApp Business Cloud API v25.0
- **Push notifications**: `web-push` library (no Firebase)
- **Data fetching**: TanStack Query
- **Styling**: Tailwind CSS + shadcn/ui components
- **State management**: TanStack Query for server state, React Context for app state

## Required CLIs and MCPs

These must be used as the primary way to configure their respective services. Avoid the web dashboard where the CLI/MCP can do the job.

- **Supabase CLI** + **Supabase MCP** — for migrations, RLS policies, seed data, type generation, local development, project management
- **GitHub CLI** (`gh`) + **GitHub MCP** — for repo creation, branches, PRs, secrets, Actions, deploy keys
- **Vercel CLI** + **Vercel MCP** — installed but NOT used for hosting this project (we deploy to Railway). May be used for documentation lookup or future preview deployments.

When performing infrastructure work, prefer CLI/MCP calls over manual UI clicks so the actions are reproducible and auditable.

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
7. **Model routing** — Sonnet 4.6 only for full conversational responses; Haiku 4.5 for photo matching, classification, sentiment, and any preprocessing step
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
│   │   │   │   ├── system.ts (main chatbot prompt for Sonnet 4.6)
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
- `POST /api/webhook/whatsapp` — **Main chatbot entry point.** Dedup via `processed_messages`, rate-limit check, Sonnet 4.6 conversation, tools: `extract_order` / `record_daily_order` / `escalate_to_human` / `ask_admin_for_help`. After each inbound customer message is saved to `conversations`, Haiku auto-summarizes durable customer context via `src/lib/claude/learn-context.ts`, replaces the `[AI learned context]` block in `customers.notes`, and feeds the freshly learned notes into the same bot response when available; failures are logged and never block replying. Also handles welcome sequence: resolves `{{dapur_list}}`, `{{delivery_areas}}`, `{{price_20}}`, `{{order_deadline}}` placeholders in `welcome_message` setting from live DB data, then sends menu images from active subcontractor rows. The welcome greeting + price list image + each menu image are also logged to `conversations` as `assistant` rows (`model_used: "system"`, image rows use `message_type: "image"` with the URL as content) so they render in the dashboard inbox.

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
- `GET /api/customers` — List customers who have at least one paid order (status `payment_proof_received`/`active`/`paused`/`completed`); leads and unpaid/cancelled do not surface. `?all=true` returns every customer (used by the new-order modal so an admin can start the first order for a just-created, order-less customer)
- `POST /api/customers` — Create a customer (e.g. someone who ordered a package manually via WhatsApp and isn't onboarded yet). Allowlisted fields only (`name, phone_number, area, sub_area, address, address_2, google_maps_link, subcontractor_id`); `phone_number` and `address` (primary address) are required, `address_2` (secondary address) is optional; `phone_number` must be unique (duplicate → 409 with `existingId`). Used by the "+ Add customer" form on the Customers page and the inline "+ Buat pelanggan baru" creation in the new-order modal.
- `DELETE /api/customers/[id]` — Delete customer: detaches payment proofs, removes conversation state and rate limit records
- `PATCH /api/customers/reorder` — Bulk-update `delivery_position` for multiple customers; body: `{ updates: [{ id, delivery_position }] }`

Conversion tracking columns on `customers` (migration 042): `ad_creative` (e.g. `"C4"`, auto-detected from first WhatsApp message), `first_message`, `converted_at` (set on first `mark_paid`), `package`, `total_portions`, `total_payment`, `promo_used` (manual), `converted_to_subscription` (boolean), `notes`. All editable via the customer detail panel.

Second address columns on `customers` (migration 044): `address_2`, `area_2`, `sub_area_2`, `google_maps_link_2`. Linked to `daily_deliveries.address_slot` (1 = primary, 2 = secondary, default 1).

Standing per-meal address rule on `orders` (migration 048): `lunch_address_slot`, `dinner_address_slot` (`smallint`, `IN (1, 2)`, default 1). Set in the new-order modal (toggles shown only when the customer has `address_2`). The `generate-deliveries` cron stamps each generated `daily_deliveries` row's `address_slot` from the matching meal's order slot, and scheduled orders stamp their rows at creation. A per-day flip on the daily sheet still overrides for a single day.

### Deliveries
- `GET /api/deliveries/daily-sheet` — Fetch delivery rows for a given date
- `POST /api/deliveries/daily-sheet` — Create daily delivery rows for a date
- `PUT /api/deliveries/daily-sheet` — Save edited rows for a date (upsert `daily_deliveries`, post revenue/COGS journals per non-skipped row; quota deduction handled by the nightly cron). Every row links an `order_id` (a draw always comes from a package).
- `GET /api/deliveries/addable-customers` — List customers Agnes can manually add to a daily sheet (a customer who decided to draw extra from their package for a date but has no auto-generated row). A draw always comes from a package — customers cannot buy a fresh one-off — so only customers **with an active recurring order** are returned, each with the address/route fields the sheet renders plus their `active_order`. The Deliveries → Daily Sheet tab has an "Add customer" button → modal (searchable customer combobox, meal type, portions, dapur) that appends a `daily_deliveries` row (linked to the active order's `order_id`) to local state; admin clicks Save to persist (nightly cron deducts quota, save posts journals).
- `GET /api/deliveries/proofs` — List payment proof photos with signed URLs
- `POST /api/deliveries/proofs` — Upload proof photo (admin upload); stamps `received_at` to the admin-selected delivery date so it lands on the right day, inserts with `status: "admin_uploaded"` and `matched_customer_id`; surfaces in the "Ready to send" section of the Proof of Delivery tab.

### Inbox (admin-guided bot responses)
- `POST /api/inbox/bot-reply` — Admin provides a concise answer → Haiku polishes it → bot sends polished message to customer → clears `pending_bot_response` flag
- `POST /api/inbox/learn-context` — Manual fallback for the same learned-context summarizer used by the webhook auto-learn path. Requires admin auth and `{ customer_id }`; writes only the `[AI learned context]` block in `customers.notes`.

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
- `POST /api/subcontractors/off-days` — Add an off day for a subcontractor
- `DELETE /api/subcontractors/off-days` — Remove an off day

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
- `POST /api/assistant` — Multi-turn agentic chat using Sonnet 4.6. Runs tool loop (max 5 turns) with read tools: `query_customers`, `query_orders`, `query_deliveries`, `query_financials`, `query_metrics`, `search_conversations`, `query_menu_assets`. Write tools (`mark_order_paid`, `cancel_order`, `send_whatsapp_message`, `send_whatsapp_image`, `update_customer_field`) are intercepted — returns `{ ok: true, text, pendingAction }` instead of executing. If Claude proposes multiple WhatsApp send actions in one response (for example menu image + price list image), the route returns one `pendingAction` with `tool: "batch"` and an `actions` array so the admin confirms once and every send is preserved. Body accepts optional `conversationId`; if absent, a new thread is created lazily and returned. Each turn (user msg + reply) is persisted to `assistant_conversations` / `assistant_messages` (shared across all admins). Requires auth.
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

Jest test suite lives in `test/`. Uses `next/jest` (`nextJest()` config helper), `testEnvironment: "node"`, and `jest.mock()` for all external dependencies (Supabase, Claude, WhatsApp). No real network calls.

Current coverage (107 tests across 18 suites):

Phase 1 — webhook safety paths and basic API coverage:
- `test/webhook.test.ts` — 8 tests: idempotency, kill switch, blacklist, human escalation, rate limit, circuit breaker, Claude 529 retry, Claude non-retryable error
- `test/api/orders.test.ts` — 7 tests: `mark_paid`, `update_size "m"`, invalid size returns 400, `update_fields` writes only allowlisted columns (drops total_price/status/price_per_portion), `update_fields` invalid size → 400, `update_status "paused"` succeeds, `update_status "active"` → 400
- `test/api/settings.test.ts` — 2 tests: upsert setting key, update message template

Phase 2 — business logic and data integrity:
- `test/api/orders-post.test.ts` — 6 tests: total_price = package_size × price_per_portion (+ address slots default to 1), per-meal address slots persisted (lunch 1, dinner 2), size defaults to "s", missing start_date returns 400, scheduled order derives package_size from schedule sum, scheduled delivery rows stamped with per-meal address slot
- `test/api/customers-delete.test.ts` — 3 tests: deletion order (proofs → deliveries → orders → customer), early exit on proof detach error, unauthenticated returns 401
- `test/api/inbox.test.ts` — 4 tests: Haiku polishes answer and clears pending flag, blank admin_answer returns 400, unknown customer returns 404, no pending flag returns 400

Phase 3 — admin assistant:
- `test/api/assistant.test.ts` — 8 tests: auth guard, invalid body, read-only tool loop, write-tool interception returns pendingAction, batch pendingAction for multiple WhatsApp sends, turn cap, unauthenticated returns 401
- `test/api/assistant-execute.test.ts` — 8 tests: auth guard, invalid tool rejected, mark_order_paid success + side effects, update_customer_field allowlist, disallowed field returns 400, order not found returns 404, image sends upload URL content to Meta and send by media ID, batch image sends execute every image

Phase 4 — assistant chat history:
- `test/api/assistant-history.test.ts` — 10 tests: conversations list/create auth + data, [id] messages + delete auth + data, saveTurn title derivation on first message vs subsequent

Phase 5 — delivery proofs:
- `test/api/delivery-proofs.test.ts` — 5 tests: POST stamps `received_at` to selected date, POST missing customer_id returns 400, PATCH send sets `manually_sent` + side fields, PATCH unmatch, unauthenticated GET/POST return 401

Phase 6 — accounting reports & chart-of-accounts management:
- `test/api/accounting.test.ts` — 5 tests: manual journal POST auth/balance/unknown-account/valid-insert
- `test/api/accounting-accounts.test.ts` — 8 tests: POST create (auth, invalid code, invalid type, duplicate code, normal_balance derived from type for Asset/Expense vs Liability), PATCH (auth, empty patch 400, toggle `is_active`)
- `test/api/accounting-reports.test.ts` — 8 tests: reports auth + invalid type, trial_balance net-on-normal-side + balanced, pnl netIncome, balance_sheet earnings-into-equity + balanced; ledger missing/unknown account, running-balance computation

Phase 7 — add customer to daily sheet:
- `test/api/addable-customers.test.ts` — 2 tests: unauthenticated returns 401, returns only customers with an active package (one-offs impossible) with the order attached

Phase 8 — create + list customers:
- `test/api/customers-post.test.ts` — 7 tests: POST unauthenticated returns 401, missing phone_number returns 400, missing address returns 400, duplicate phone returns 409 with `existingId`, valid insert trims phone + carries optional address_2 + only allowlisted fields reach the insert; GET default lists only paid customers (queries orders, filters by id), GET `?all=true` returns every customer without the paid filter

A pre-push hook (`.git/hooks/pre-push`) runs `pnpm lint && pnpm typecheck && pnpm test` before every push and blocks if any fails.

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
- Never deploy this project to Vercel — Railway only (Vercel CLI/MCP is installed for other purposes)
- Never create `middleware.ts` — Next.js 16 uses `proxy.ts` with `export function proxy()` (or default export)

## Known issues / tech debt

- `/api/auth/check-admin` accepts the email from the request body without verifying the caller's session — allows unauthenticated admin email enumeration via 200 vs 403 response. Fix: extract email from a verified Supabase session instead.
- **Manual delivery proof upload** (`POST /api/deliveries/proofs`, `match_method: "admin_upload"`) saves the proof with `received_at` stamped to the selected delivery date and surfaces it in a "Ready to send" section in the Proof of Delivery tab. The Daily Sheet row's camera/checkmark icon derives from whether a proof exists for that customer+date (DB-backed, survives refresh). Sending moves the proof to a "Manually sent" section (`status: "manually_sent"`). Future: auto-send to customer immediately on upload — call `sendDeliveryPhotoToCustomer(proofId, customerId)` directly in the POST route, skipping the "Ready to send" UI step entirely.
- `supabase/seed.sql` may still reference the old `"BSD"` delivery area string (not yet split into BSD Baru / BSD Lama); `subcontractors-client.tsx` was updated when Karawaci was added.
- **Accounting Phase 4 — reverse/void entries (TODO).** No edit allowed on journals (append-only audit principle). Instead add a "Balik jurnal" action that posts a mirror entry (swap debit/credit), linked via a new `reversed_journal_id` column on `journals`. Restrict to `source_type: "manual"` entries — auto-posted (`order_payment`/`delivery`) stay locked. Verify: a reversed pair nets to zero in the trial balance.
- **Accounting Phase 5 — export + quick expense (TODO).** (a) CSV export for journals/ledger via `?export=true`, matching the `/api/reports/conversions` export pattern. (b) Quick-expense form: pick an expense account + a bank/cash account + amount → auto-build the 2-line balanced journal, so Annie doesn't hand-enter raw debit/credit.
- **Domain naming refactor — disambiguate "order" (TODO, big, deferred).** Today `order` means the prepaid *package* (the 20-portion quota) everywhere — `orders` table, `/api/orders`, `extract_order`, `new-order-modal`, `total_price`, `price_per_portion`, `package_size` — while the per-day quantity that *deducts* from that quota lives in `daily_deliveries` rows (`portions` per date/meal). There is no clean single word for that daily-draw layer, which causes confusion (a delivery can carry multiple portions, so "delivery" ≠ the portion-draw; "order" is already taken by the package). Two candidate fixes, both deferred:
  - **(A) Add a word, no rename (low risk, preferred).** Keep `order` = package. Name the daily-draw layer `drawdown` (alt: `redemption`) — it's the quota-accounting concept "draw N portions from prepaid balance on date D". Default draw = schedule; per-day override = explicit row. Balance = quota − Σ drawdowns. Only the new layer gets named; every existing `order` reference stays correct. Optionally decouple display labels: code keeps `order`, customer/UI says "paket" for the package and "pesanan hari ini" for the daily draw.
  - **(B) Swap the meaning of `order` (high risk).** Rename package → `package_order`, and call the daily draw `order` (matches customer mental model "I order food today"). Blast radius is huge: flips the meaning of the most-used word — `orders` table, all `/api/orders`, `orders-client.tsx`, `extract_order`, `new-order-modal`, tools, customer chat, accounting journal descriptions, docs all need re-audit + a schema split/migration. Note `record_daily_order` already half-uses "order"=daily, so the collision is live today. Grep `order` usage to size before attempting.
