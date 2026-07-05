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
- Contextual "ok" handling: post-delivery "ok" gets an enjoy-food reply; a generic affirmative "ok" gets "Ada yang bisa kami bantu?"

### Pricing

- Customer-facing chatbot prompt has the current Paket Personal S price list spelled out in `src/lib/claude/prompts/system.ts`; keep this in sync with `pricing_tiers` and `price_list_image_url`.
- Existing orders lock in `price_per_portion` at order creation time
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

## AI cost controls (9 layers)

1. **Anthropic console budget cap** — $100/month hard limit, configured outside this codebase
2. **API key hygiene** — keys only in `.env` and Railway env vars, never committed
3. **Per-customer rate limits** — 20 bot replies/day, 7 bot replies/minute, 100,000 tokens/day per customer. Exception: messages while a customer is `awaiting_payment` bypass this gate, so payment and proof-of-payment follow-up can continue even after the usual limit is hit.
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
├── API_ROUTES.md (endpoint-level reference, read on demand — see "API Routes" section)
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
│   ├── templates/ (magic_link.html — Supabase Auth email template)
│   └── seed.sql
├── src/
│   ├── app/
│   │   ├── (dashboard)/ — auth-protected admin PWA routes, one folder per nav item; each `page.tsx` here is a thin wrapper importing its real client component from `components/dashboard/`
│   │   │   ├── layout.tsx (auth-protected, role-based nav)
│   │   │   ├── page.tsx (dashboard home wrapper → `DashboardMetrics`)
│   │   │   ├── dashboard/ (route for KPI home page)
│   │   │   ├── inbox/ (route for WhatsApp thread list / admin-guided bot replies)
│   │   │   ├── customers/ (route for customer list / detail panel)
│   │   │   ├── orders/ (route for orders table / detail slide-over)
│   │   │   ├── deliveries/ (route for Daily Sheet / proof-of-delivery uploads)
│   │   │   ├── areas/ (route for delivery area management)
│   │   │   ├── payments/ (route for payment tracking/reconciliation)
│   │   │   ├── subcontractors/ (route for dapur/kitchen roster, off-days, menu images)
│   │   │   ├── broadcasts/ (route for filtered WhatsApp broadcast composer)
│   │   │   ├── chatbot-training/ (route for Annie's system-prompt training chat)
│   │   │   ├── reports/ (route for revenue/orders/churn/conversion analytics)
│   │   │   ├── settings/ (route for pricing tiers, templates, admins, kill switch)
│   │   │   ├── assistant/ (route for agentic admin chat w/ confirm-before-write tools)
│   │   │   └── guide/ (in-app usage docs for admins)
│   │   ├── (auth)/
│   │   │   ├── login/ (magic-link email login)
│   │   │   └── callback/ (Supabase Auth callback handler)
│   │   ├── dapur/[id]/ — public, auth-free mobile page per subcontractor: tomorrow's delivery orders
│   │   ├── privacy/ (public privacy-policy page)
│   │   └── api/ — route handlers; see "API Routes" section below for endpoint-level detail
│   │       ├── webhook/whatsapp/ (Meta webhook: main chatbot entry point)
│   │       ├── cron/ (Railway cron targets: reminders, cancellations, digests, delivery-gen)
│   │       ├── push/ (VAPID config, subscribe, test push)
│   │       ├── auth/ (admin email check, signout)
│   │       ├── dashboard/ (KPI metrics endpoint)
│   │       ├── orders/, customers/, deliveries/, subcontractors/, settings/, reports/ (CRUD for each dashboard page above)
│   │       ├── inbox/ (bot-reply, learn-context, pipeline-stage, replay-latest, delivery-proofs proxy)
│   │       ├── broadcasts/ (preview + send)
│   │       ├── assistant/ (agentic chat + execute + conversation threads)
│   │       ├── accounting/ (journals, accounts, reports, ledger — owner-only)
│   │       ├── context/ (customer/preview context lookups used by admin tooling)
│   │       ├── chatbot-instructions/ (CRUD for saved chatbot instruction rules)
│   │       ├── chatbot-simulator/ (test the chatbot without sending real WhatsApp messages)
│   │       ├── training-chat/ (backs the chatbot-training page)
│   │       ├── admin/send-delivery-photo/ (send a delivery proof photo to a customer)
│   │       ├── whatsapp/ (manual text send from dashboard)
│   │       └── health/ (liveness probe)
│   ├── proxy.ts (Supabase SSR session refresh — Next.js 16 "proxy" convention, replaces middleware.ts)
│   ├── lib/
│   │   ├── supabase/ — Supabase client factories
│   │   │   ├── client.ts (browser)
│   │   │   ├── server.ts (server)
│   │   │   ├── admin.ts (service role, server-only)
│   │   │   └── get-role.ts (getSessionWithRole + isOwner helpers)
│   │   ├── claude/ — chatbot brain: prompts, conversation history, safety gates
│   │   │   ├── client.ts
│   │   │   ├── conversation.ts (history management, token budget)
│   │   │   ├── prompts/
│   │   │   │   ├── system.ts (main chatbot prompt for Sonnet 5)
│   │   │   │   └── classifier.ts (Haiku 4.5 classifier)
│   │   │   ├── photo-matcher.ts (Haiku 4.5 photo matching)
│   │   │   ├── classify-address.ts (Haiku address/area classification)
│   │   │   ├── safety.ts (rate limits, circuit breaker, echo detection)
│   │   │   ├── validate-reply.ts (Haiku hallucination check before send)
│   │   │   ├── learn-context.ts (Haiku auto-summarizes durable customer notes)
│   │   │   ├── assistant-prompt.ts (system prompt for the Admin Assistant)
│   │   │   ├── assistant-tools.ts (Admin Assistant's read/write tool definitions + handlers)
│   │   │   └── assistant-history.ts (Admin Assistant conversation thread persistence)
│   │   ├── whatsapp/ — Meta Cloud API integration
│   │   │   ├── client.ts (send messages, typing indicators)
│   │   │   ├── webhook.ts (HMAC signature verification for inbound webhooks)
│   │   │   └── types.ts
│   │   ├── accounting/
│   │   │   └── journal.ts (post balanced journal entries: revenue/COGS, mark-paid, free-quota)
│   │   ├── cache/
│   │   │   └── settings.ts (in-memory settings/templates cache, refreshed every 60s)
│   │   ├── images/
│   │   │   └── compress.ts (image compression before upload, e.g. menu/proof photos)
│   │   ├── push/
│   │   │   └── send.ts (web-push wrapper)
│   │   ├── utils/ — shared formatting/timing helpers
│   │   │   ├── delay.ts (dynamic typing delay)
│   │   │   └── format.ts (currency, dates, getDeliveryRoute())
│   │   ├── env.ts (typed required-env-var accessor)
│   │   └── utils.ts (generic helpers, e.g. `cn()` classname merge for shadcn)
│   ├── components/
│   │   ├── ui/ (shadcn primitives)
│   │   ├── dashboard/ — **where the actual page logic/UI lives.** Every `app/(dashboard)/*/page.tsx` is just a thin wrapper importing its matching `*-client.tsx` here
│   │   │   ├── dashboard-metrics.tsx (KPI widgets for the dashboard home page)
│   │   │   ├── push-subscribe-button.tsx (browser push opt-in button, used on dashboard home)
│   │   │   ├── inbox-client.tsx (WhatsApp thread list, admin-guided bot replies, human takeover)
│   │   │   ├── inbox-filters.ts (All/Unread/Unanswered filter + search logic for inbox-client)
│   │   │   ├── customers-client.tsx (customer list, detail panel, free-quota grants)
│   │   │   ├── orders-client.tsx (orders table, detail slide-over, mark-paid, status changes)
│   │   │   ├── new-order-modal.tsx (create-order modal used from orders-client / customers-client)
│   │   │   ├── deliveries-client.tsx (Daily Sheet, proof-of-delivery uploads)
│   │   │   ├── areas-client.tsx (delivery area management, derived from active subcontractors)
│   │   │   ├── payments-client.tsx (payment tracking/reconciliation UI)
│   │   │   ├── subcontractors-client.tsx (dapur/kitchen roster, off-days, menu images)
│   │   │   ├── broadcasts-client.tsx (natural-language filtered WhatsApp broadcast composer)
│   │   │   ├── chatbot-training-client.tsx (Annie's chat UI for crafting system-prompt instructions)
│   │   │   ├── reports-client.tsx (revenue/orders/churn/conversion analytics)
│   │   │   ├── settings-client.tsx (pricing tiers, templates, admins, kill-switch toggle)
│   │   │   ├── kill-switch.tsx (chatbot on/off toggle, used inside settings-client)
│   │   │   ├── accounting-client.tsx (journals, chart of accounts, financial reports, ledger)
│   │   │   ├── assistant-client.tsx (agentic admin chat UI: query + write tools w/ confirm step)
│   │   │   └── assistant-widget.tsx (floating shortcut into the assistant, embedded on other pages)
│   │   └── shared/ (cross-page components: mobile nav, query provider, service worker registrar)
│   └── types/
│       └── database.ts (generated by `supabase gen types`)
└── scripts/
    ├── audit-sheet-data.ts (re-runnable data audit; scans CUSTOMERS/ORDER_HARIAN/package_orders sheets vs the DB customers table → writes DATA_AUDIT.md listing name mismatches (with "did you mean" suggestions), orphan purchases (package_orders rows with money/portions but blank name), blank-name deliveries, and zero/typo values. Run: `set -a && . ./.env.local && set +a && pnpm tsx scripts/audit-sheet-data.ts`)
    ├── import-customers-orders.ts (re-runnable Google Sheets → Supabase import; fetches CSV directly via export URL, upserts customers by phone_number, skips orders for customers that already have active orders. Flags: `--skip-customers` (build name→id maps from DB, import deliveries only), `--after=YYYY-MM-DD` (only ORDER_HARIAN rows after date), `--until=YYYY-MM-DD` (only ORDER_HARIAN rows through date — pairs with `--after` so post-cutover deliveries, which live only in app-entered `daily_deliveries`, aren't double-imported), `--reconcile` (recompute every customer's remaining quota = Σ package_orders.Porsi − Σ [ORDER_HARIAN through the cutover + daily_deliveries after it]; writes customers.portions_remaining/avg_price + the customer's oldest active order's package_size/portions_remaining/price/total; skips overwriting a customer whose only post-cutover order already has a real non-zero package_size — in-app entry wins over stale sheet data; never touches status/customers/journals), `--dry-run` (with --reconcile: print per-customer pkg/delivered/remaining diff table + unmatched-name warnings, write nothing). Three sheet tabs on one spreadsheet: CUSTOMERS gid 1454452383, ORDER_HARIAN gid 1975392427, package_orders gid 341974326.)
    ├── dedup-customers.ts (one-off: merges duplicate customers created when an import ran with a real phone against an existing `IMPORT_<slug>` placeholder from a prior run — reassigns orders, deletes the placeholder)
    ├── test-webhook.ts (`pnpm test:webhook "<message>" [phone]` — simulates an inbound WhatsApp message against the local dev server with a valid HMAC signature)
    └── upload-welcome-assets.ts (one-off: uploads price list + Dapur 2 menu images to Supabase storage and saves the URLs to settings)
```

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
