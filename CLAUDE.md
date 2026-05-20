@AGENTS.md

# Pian Yi Catering — Project Context

This file is read at the start of every Claude Code session. It contains permanent context, conventions, and rules for the project.

## What this project is

A WhatsApp-based ordering system for Pian Yi Catering, a daily catering business serving BSD City, Gading Serpong, Alam Sutera, Bintaro, and Graha Raya in Tangerang Selatan, Indonesia.

Two end users:

- **Customers** — interact only via WhatsApp with an AI chatbot powered by Claude Sonnet 4.6
- **Admins** (Justin and Annie) — interact via a PWA dashboard for operations

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

- Stored in `pricing_tiers` table, never hardcoded
- Existing orders lock in `price_per_portion` at order creation time
- Tiers: 1=30k, 2=29k, 5=28k, 10=27k, 20=26k, 40=25k, 80=24k (current values)

### Delivery

- Areas: BSD, Gading Serpong, Alam Sutera, Bintaro, Graha Raya (stored in `settings`)
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

## AI cost controls (9 layers)

1. **Anthropic console budget cap** — $100/month hard limit, configured outside this codebase
2. **API key hygiene** — keys only in `.env` and Railway env vars, never committed
3. **Per-customer rate limits** — 20 bot replies/day, 5 bot replies/minute, 100,000 tokens/day per customer
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
│   │   │   └── settings/
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
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts (browser)
│   │   │   ├── server.ts (server)
│   │   │   └── admin.ts (service role, server-only)
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
    └── seed.ts (initial settings/templates seed)
```

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

## Tooling commands

Standard commands (always use these spellings):

- Install: `pnpm install`
- Add dep: `pnpm add <pkg>`
- Add dev dep: `pnpm add -D <pkg>`
- Run script: `pnpm <script>`
- Dev server: `pnpm dev`
- Build: `pnpm build`
- Lint: `pnpm biome check .`
- Format: `pnpm biome format --write .`
- Type-check: `pnpm tsc --noEmit`
- Supabase types: `pnpm supabase gen types typescript --linked > src/types/database.ts`
- Supabase migrate (local): `pnpm supabase db reset`
- Supabase push (remote): `pnpm supabase db push`
- GitHub: use `gh repo`, `gh pr`, `gh secret set`, `gh workflow` for all repo operations

## Testing & deployment notes

- Local dev: Supabase CLI local stack (`pnpm supabase start`) OR a dedicated staging Supabase project
- Production deployment: Railway via GitHub auto-deploy on push to `main`
- Environment variables required (see `.env.example`)
- Webhook URL after deploy: `https://[railway-app].up.railway.app/api/webhook/whatsapp`
- Cron jobs configured via Railway's cron feature, hitting `/api/cron/*` endpoints with `CRON_SECRET` header verification
- Repo created and managed via GitHub CLI

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
