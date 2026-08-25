<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->


# Pian Yi Catering — Project Context

Read at the start of every session. Permanent context, conventions, and the rules that are dangerous to break without knowing why they exist.

**This file is a map, not the whole territory.** It stays under 200 lines so it can be loaded every session; the detail lives in topical files, read on demand:

| File | Read it before |
| --- | --- |
| `TASKS.md` | **anything** — the live queue of outstanding work, dated items first |
| `BOT_RULES.md` | changing the customer-facing chatbot, its prompt, order extraction, or the recovery guards |
| `OPERATIONS.md` | pricing, order lifecycle, delivery generation, quota draws, subcontractor billing |
| `WHATSAPP.md` | outbound sends, the webhook, the 24h window, WABA account state |
| `ADMIN.md` | roles, inbox takeover, the Assistant's tools |
| `DATABASE.md` | schema, columns, migrations |
| `API_ROUTES.md` | endpoint-level API reference |
| `DEV_REFERENCE.md` | AI cost controls, folder tree, tooling, tests, push internals |
| `OVERDRAW.md` | the 32 customers who have drawn more than they bought |

Each of those keeps the incident that produced each rule. That is deliberate: a rule stripped of its reason gets "simplified" back into the bug.

## What this project is

A WhatsApp-based ordering system for Pian Yi Catering, a daily catering business in Tangerang Selatan, Indonesia. **Which areas we serve is not a fixed list** — it is the union of the `delivery_areas` of whichever subcontractors are currently active. Each kitchen carries its own list; those lists overlap in part and differ in part, so an area may be served by three kitchens or by one. Never write the areas into a doc, a prompt, or a string; read them. See "Delivery areas" in `OPERATIONS.md`.

Two end users:

- **Customers** — interact only via WhatsApp with an AI chatbot (DeepSeek V4 Flash; see the AI line below — the code says "Sonnet" but nothing here runs on Claude)
- **Admins** (Justin, Annie, Daevin) — interact via a PWA dashboard for operations; Justin and Annie are `owner` role, Daevin is `admin` role (see `ADMIN.md`)

## Tech stack

- **Framework**: **Next.js 16.2.6 exclusively** (App Router) with TypeScript. Do not upgrade or downgrade.
- **Package manager**: **pnpm exclusively**. Never use npm, yarn, or bun. All scripts, install commands, and lockfiles must be pnpm.
- **Linter / formatter**: **Biome exclusively**. Do not use ESLint or Prettier.
- **Hosting**: Railway (always-on Node.js, `output: 'standalone'` mode, NOT serverless)
- **Database**: Supabase (PostgreSQL) with Row Level Security
- **Auth**: Supabase Auth (magic link email login for admins only)
- **AI**: the Anthropic SDK pointed at DeepSeek via `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`. Both `CLAUDE_SONNET_MODEL` and `CLAUDE_HAIKU_MODEL` are `deepseek-v4-flash` in production — the code's "Sonnet" (customer chat, order conversations, training mode) and "Haiku" (photo matching, classification, sentiment, FAQ routing) names describe the *role*, not the model. Check the env before consulting any provider's docs. DeepSeek reasons by default, which broke replies three separate ways, so every call spreads `NO_THINKING` — see "Reading model responses" in `DEV_REFERENCE.md`.
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

- Work happens either directly on `main` or in git worktrees on feature branches.
  - **On main:** commit and push after every change.
  - **On a worktree branch:** commit and push the branch, then open a PR to merge into main.
- **REQUIRED before every commit, no exceptions:** Update any affected root `.md` file — edit the specific section the change affects. Never append a dated changelog entry at the bottom; always edit the relevant section in-place. These updates go in the same commit as the code change. If you skipped this, make a follow-up commit immediately.
- **Write the detail in the topical doc, not here.** A new rule and the incident behind it belong in `BOT_RULES.md`, `OPERATIONS.md`, `WHATSAPP.md`, `ADMIN.md` or `DATABASE.md`. `CLAUDE.md` gets a line only when a session that never opens the topical doc could still destroy something by not knowing — and then one sentence, not the story. This file was split at 506 lines because every fix had been appended to it; it is capped at 200 and that cap is the point.
- Version bumping is handled by a local `post-commit` hook (`.githooks/commit-msg`) — it amends the commit to include the bumped `package.json`. No GitHub Actions workflow involved.

When performing infrastructure work, prefer CLI calls over manual UI clicks so the actions are reproducible and auditable.

**Budget note:** Justin on $20/month Claude Pro plan — limited usage cap. Avoid spawning Agent/subagents for bounded, known-target tasks (single file, known symbol); do those inline w/ Read/Edit/Bash/Grep. Reserve Agent for genuinely open-ended multi-file research or when explicitly requested.

## Architectural principles

1. **Land it, then 200, then process** — the webhook writes the raw payload to `webhook_events`, returns 200 to Meta, and processes async. Acknowledging before the payload is durable turns a database outage into silent message loss, since Meta never retries a 200 (see "Idempotency strategy" in `WHATSAPP.md`)
2. **Idempotency everywhere** — every webhook event has a `message_id`, check against `processed_messages` table before processing
3. **Defense in depth** — 10 layers of cost protection (see "AI cost controls" in `DEV_REFERENCE.md`)
4. **Settings over hardcoding** — anything that might change goes in the `settings` table, edited via UI
5. **Server-controlled fields** — `id`, `created_at`, `updated_at`, `status`, `total_price` are always set by server, never accepted from client input
6. **Allowlist field updates** — when updating records, explicitly list permitted fields; never use mass assignment
7. **Sensitive fields in separate tables** — rate limits, flags, internal status live in tables users cannot edit
8. **Audit log append-only** — `edit_log`, `processed_messages`, `conversation_logs` are insert-only, never updated or deleted. Every mutating route records its actor with `logEdit()` (`src/lib/audit/log-edit.ts`), which never throws — it runs after the business write has landed. **A dashboard write must go through an API route**: three screens wrote to Postgres straight from the browser and nothing could record who did it. Read the trail at `/activity`
9. **Never fetch a fixed window and aggregate in the browser** — "newest N rows, then group/filter client-side" silently drops data once the table outgrows N, and the UI gives no signal that it happened. Aggregate in the database (a view, or a query that returns the answer) and paginate with `.range()` when a list must be complete. This has already caused three separate bugs: `GET /api/orders` capped at 100 of 432 orders (twice), and the inbox capped at 500 `conversations` rows, which hid every lapsed customer's thread.


## Business rules — the load-bearing ones

Full versions, with the incidents behind them, in `BOT_RULES.md` and `OPERATIONS.md`. These are the ones where getting it wrong costs money or a customer.

**Confidentiality.** Never disclose **any** subcontractor's real name to customers, in any form. Customers only ever see the `customer_nickname` ("Dapur 1", "Dapur C"). The rule covers every row in `subcontractors`, present and future — never an enumerated list, in a doc or a prompt, because such a list is always short by however many kitchens were added since it was written. Frame as "dapur partner kami". What is confidential is *which* kitchens, never that partner kitchens exist: a customer who names a supplier gets neither denial nor confirmation, because "kami masak sendiri" is a lie they can find out. **Never put the bank account number in the bot's system prompt** — the payment message is composed by `createOrderFromExtraction`, and the model has never needed it. Never reveal COGS, margins, or internal operations; customer-facing errors are always generic.

**Language.** Indonesian only, "kak" as honorific, under 200 words, emojis sparingly. Enforced, not asked for: every outbound webhook reply runs the hallucination validator → `looksEnglish()` → `sanitizeReply()`, and the sanitized text is what gets saved.

**Pricing.** S-only ladder in `pricing_tiers`, 5 → 144 portions, 29k → 25k per portion, mirrored in `system.ts`. A total off the list but divisible by 5 or 6 is sellable at the rate of the **largest listed size below it** — never as repeated smaller packages, which charged more for a bigger order. `customers.contract_price_per_portion` replaces the ladder entirely for corporate customers. Existing orders lock `price_per_portion` at creation. **A one-off event order is priced by tendering it to the kitchens, never off the ladder** — the bot gathers the brief and escalates, and must not call `extract_order`, because creating the order is what sends the bank details. See "A custom/event order is tendered to the kitchens" in `OPERATIONS.md`.

**Order lifecycle.** `pending_payment` → `payment_proof_received` → `active` → `paused` → `completed`, plus the cancellation statuses. `orders.status` is the source of truth for payment and subscription state; `customer_state` is customer-level only (`new`/`ordering`/`lapsed`/`churned`) and must not mirror payment stages.

**Delivery.** Senin–Sabtu, Minggu closed, libur nasional closed (`src/lib/holidays/id.ts` — extend before it lapses on 2026-12-31). Cuti bersama is an escalation, not a closure. Order deadline 16:00 WIB the day before (`settings.order_deadline_hour`), for changes and skips as well as new orders. The bot is handed the WIB clock and a computed "cutoff passed / still open" verdict plus the soonest deliverable date (`src/lib/time/jakarta.ts`) — never the bare hour, which it read as permanently still ahead. Areas come from active subcontractors' `delivery_areas`, never `settings` and never a literal in code, a prompt or a doc — read them with `activeDeliveryAreas(db)` (`src/lib/subcontractors/areas.ts`) or `useDeliveryAreas()` in the dashboard. They are **per kitchen, not global**, and some areas rest on a single kitchen, so deactivating one subcontractor can remove an area entirely.

**Sheet generation never writes a row an order has no unbooked quota for** (`unbookedByOrder()`) — without that guard an `active` order with a standing `meal_time_preference` generates rows past its package forever; 21 of 28 rows built for 2026-08-21 were already over-draws. See `OPERATIONS.md`.

**Which order a delivery draws from is `pickDrawOrder()`, never query order** (`src/lib/orders/pick-draw-order.ts`): oldest active order with `portions_remaining > 0`, else the newest active one. Never reintroduce a bare `.limit(1)` on active orders — 85 customers hold two or more at once. An order completes on what it has **delivered** (`orderRemainingToday()`), never on `portions_remaining` — which hits 0 when the calendar fills — and never on the customer counter.

**`customers.portions_remaining` and `customers.avg_price_per_portion` are dead columns — never read them.** They are the unfinished half of migration 035 and disagree with reality for a third of customers. Every decision path reads `orders.portions_remaining`; keep it that way.

**`orders.portions_remaining` is portions not yet *booked*, not portions not yet *delivered*.** A customer whose whole package is already on the calendar reads 0 while still owed every meal. Never quote it to a customer as their remaining balance — use `remainingToday` from the order ledger or `loadCustomerSchedule()`. See "Sisa kuota" in `OPERATIONS.md`.

**`orders.order_type` is gone** (migration 063). The question it pretended to answer is answered by `meal_time_preference` via `FIXED_SCHEDULE_PREFS`. Do not add a new flag.

**One order per purchase.** `extract_order` amends the customer's open `pending_payment` order rather than inserting a second one; a promise the bot makes without calling the tool is recovered from the conversation, but only when the customer typed the size themselves. Both halves have already produced phantom orders billed to real customers.

**The 24-hour window is told to the customer, not hidden** (`src/lib/whatsapp/window-notice.ts`). And right now **every business-initiated send fails on `131042`** — the WABA has a payment restriction. Delivery proofs, templates and the window-refresh fallback are all dead letters until it is cleared by hand. The send endpoint still returns 200 `accepted`; the failure only arrives in the status webhook, so a successful POST is never proof the channel works.

**Roles.** `owner` (Justin, Annie) has everything. `admin` (Daevin) has everything except Accounting and inbox takeover, and cannot hand-type to a customer at all — enforced server-side, not just hidden. Removing an admin is one delete (`admin_users`); push sends filter against that table. Who did what is in `edit_log` and, for hand-typed messages, `conversations.sent_by` — see "Who did what" in `ADMIN.md`.

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
- Stage only files relevant to the change; leave unrelated dirty worktree files untouched
- When embedding `customers(...)` from an `orders`-rooted Supabase query, always use the explicit FK hint: `customers!orders_customer_id_fkey(...)` — the table has two FKs to `customers` and will return `PGRST201` without it

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

**`TASKS.md` is the live queue** — bugs with file:line pointers, what is blocked on Justin, the deferred designs (Instagram generator, accounting phases 4–5, the `drawdown` naming refactor), and the dated items this file has no place for. Read it before picking up work.
