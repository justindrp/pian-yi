<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->


# Pian Yi Catering — Project Context

Read at the start of every session. Permanent context, conventions, and the rules that are dangerous to break without knowing why they exist.

**This file is a map, not the whole territory.** It stays under 200 lines so it can be loaded every session; the detail lives in topical files, read on demand:

| File | Read it before |
| --- | --- |
| `pnpm tasks` (not a file) | **anything** — the live queue, printed from the `tasks` table; edit it at `/tasks` |
| `docs/BOT_RULES.md` | changing the customer-facing chatbot, its prompt, order extraction, or the recovery guards |
| `docs/OPERATIONS.md` | pricing, order lifecycle, delivery generation, quota draws, subcontractor billing |
| `docs/WHATSAPP.md` | outbound sends, the webhook, the 24h window, WABA account state |
| `docs/ADMIN.md` | roles, inbox takeover, the Assistant's tools |
| `docs/DATABASE.md` | schema, columns, migrations |
| `docs/API_ROUTES.md` | endpoint-level API reference |
| `docs/DEV_REFERENCE.md` | AI cost controls, folder tree, tooling, tests, push internals |
| `docs/OVERDRAW.md` | the 32 customers who have drawn more than they bought |

Each of those keeps the incident that produced each rule. That is deliberate: a rule stripped of its reason gets "simplified" back into the bug.

## What this project is

A WhatsApp-based ordering system for Pian Yi Catering, a daily catering business in Tangerang Selatan, Indonesia. **Which areas we serve is not a fixed list** — it is the union of the `delivery_areas` of whichever subcontractors are currently active. Each kitchen carries its own list; those lists overlap in part and differ in part, so an area may be served by three kitchens or by one. Never write the areas into a doc, a prompt, or a string; read them. See "Delivery areas" in `docs/OPERATIONS.md`.

Two end users:

- **Customers** — interact only via WhatsApp with an AI chatbot (DeepSeek V4 Flash; see the AI line below — the code says "Sonnet" but nothing here runs on Claude)
- **Admins** (Justin, Annie, Friska) — interact via a PWA dashboard for operations; all three are `owner` role and nobody holds `admin` right now (see `docs/ADMIN.md`). Justin signs in as two different emails and holds a row for each

## Tech stack

- **Framework**: **Next.js 16.2.6 exclusively** (App Router) with TypeScript. Do not upgrade or downgrade.
- **Package manager**: **pnpm exclusively**. Never use npm, yarn, or bun. All scripts, install commands, and lockfiles must be pnpm.
- **Linter / formatter**: **Biome exclusively**. Do not use ESLint or Prettier.
- **Hosting**: Railway (always-on Node.js, `output: 'standalone'` mode, NOT serverless)
- **Database**: Supabase (PostgreSQL) with Row Level Security
  - **A push to `main` applies pending migrations to production on its own** (Supabase GitHub integration). A migration that must land before or after a code deploy therefore needs its own push — see "Migrations apply themselves on push to main" in `docs/DATABASE.md`.
- **Auth**: Supabase Auth (magic link email login for admins only)
- **AI**: the Anthropic SDK pointed at DeepSeek via `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`. Both `CLAUDE_SONNET_MODEL` and `CLAUDE_HAIKU_MODEL` are `deepseek-v4-flash` in production — the code's "Sonnet" (customer chat, order conversations, training mode) and "Haiku" (photo matching, classification, sentiment, FAQ routing) names describe the *role*, not the model. Check the env before consulting any provider's docs. DeepSeek reasons by default, which broke replies three separate ways, so every call spreads `NO_THINKING` — see "Reading model responses" in `docs/DEV_REFERENCE.md`.
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
- **Write the detail in the topical doc, not here.** A new rule and the incident behind it belong in `docs/BOT_RULES.md`, `docs/OPERATIONS.md`, `docs/WHATSAPP.md`, `docs/ADMIN.md` or `docs/DATABASE.md`. `CLAUDE.md` gets a line only when a session that never opens the topical doc could still destroy something by not knowing — and then one sentence, not the story. This file was split at 506 lines because every fix had been appended to it; it is capped at 200 and that cap is the point.
- Version bumping is handled by a local `post-commit` hook (`.githooks/commit-msg`) — it amends the commit to include the bumped `package.json`. No GitHub Actions workflow involved.

When performing infrastructure work, prefer CLI calls over manual UI clicks so the actions are reproducible and auditable.

**Budget note:** Justin on $20/month Claude Pro plan — limited usage cap. Avoid spawning Agent/subagents for bounded, known-target tasks (single file, known symbol); do those inline w/ Read/Edit/Bash/Grep. Reserve Agent for genuinely open-ended multi-file research or when explicitly requested.

## Architectural principles

1. **Land it, then 200, then process** — the webhook writes the raw payload to `webhook_events`, returns 200 to Meta, and processes async. Acknowledging before the payload is durable turns a database outage into silent message loss, since Meta never retries a 200 (see "Idempotency strategy" in `docs/WHATSAPP.md`)
2. **Idempotency everywhere** — every webhook event has a `message_id`, check against `processed_messages` table before processing. The `insert` is the atomic claim, and **only error `23505` may be swallowed** — any other insert failure must throw, or the message is destroyed rather than retried. The kill switch, likewise, silences the model without skipping the writes that put the thread in the inbox (see "Idempotency strategy" in `docs/WHATSAPP.md`)
3. **Defense in depth** — 10 layers of cost protection (see "AI cost controls" in `docs/DEV_REFERENCE.md`)
4. **Settings over hardcoding** — anything that might change goes in the `settings` table, edited via UI
5. **Server-controlled fields** — `id`, `created_at`, `updated_at`, `status`, `total_price` are always set by server, never accepted from client input
6. **Allowlist field updates** — when updating records, explicitly list permitted fields; never use mass assignment
7. **Sensitive fields in separate tables** — rate limits, flags, internal status live in tables users cannot edit
8. **Audit log append-only** — `edit_log`, `processed_messages`, `conversation_logs` are insert-only, never updated or deleted. Every mutating route records its actor with `logEdit()` (`src/lib/audit/log-edit.ts`), which never throws — it runs after the business write has landed. **A dashboard write must go through an API route**: three screens wrote to Postgres straight from the browser and nothing could record who did it. Read the trail at `/activity`
9. **Never fetch a fixed window and aggregate in the browser** — "newest N rows, then group/filter client-side" silently drops data once the table outgrows N, and the UI gives no signal that it happened. Aggregate in the database (a view, or a query that returns the answer) and paginate with `.range()` when a list must be complete. This has already caused three separate bugs: `GET /api/orders` capped at 100 of 432 orders (twice), and the inbox capped at 500 `conversations` rows, which hid every lapsed customer's thread.


## Business rules — the load-bearing ones

Full versions, with the incidents behind them, in `docs/BOT_RULES.md` and `docs/OPERATIONS.md`. These are the ones where getting it wrong costs money or a customer.

**Confidentiality.** Never disclose **any** subcontractor's real name to customers, in any form. Customers only ever see the `customer_nickname` ("Dapur 1", "Dapur C"). The rule covers every row in `subcontractors`, present and future — never an enumerated list, in a doc or a prompt, because such a list is always short by however many kitchens were added since it was written. Frame as "dapur partner kami". What is confidential is *which* kitchens, never that partner kitchens exist: a customer who names a supplier gets neither denial nor confirmation, because "kami masak sendiri" is a lie they can find out. **Never put the bank account number in the bot's system prompt** — the payment message is composed by `createOrderFromExtraction`, and the model has never needed it. Never reveal COGS, margins, or internal operations; customer-facing errors are always generic.

**Language.** Indonesian only, "kak" as honorific, under 200 words, emojis sparingly. Enforced, not asked for: every outbound webhook reply runs the hallucination validator → `looksEnglish()` → `sanitizeReply()`, and the sanitized text is what gets saved.

**Pricing.** The ladder in `pricing_tiers`, 5 → 144 portions, 29k → 25k per portion, mirrored in `system.ts`. A total off the list but divisible by 5 or 6 is sellable at the rate of the **largest listed size below it** — never as repeated smaller packages, which charged more for a bigger order. **A total that is neither is refused in code** — `createOrderFromExtraction` withholds the order and offers the nearest two sizes, because the bot sold a 7-porsi package that does not exist. `customers.contract_price_per_portion` replaces the ladder entirely for corporate customers. **Size M is per kitchen (`subcontractors.offers_size_m`), never a hardcoded kitchen** — it costs the S price plus `settings.size_m_surcharge` (Rp 4.000/porsi) on every tier and on a contract rate, and a kitchen that does not cook it has an M order written as S rather than refused. See "Order sizes (S / M)" in `docs/OPERATIONS.md`. Existing orders lock `price_per_portion` at creation. **A one-off event order is priced by tendering it to the kitchens, never off the ladder** — the bot gathers the brief and escalates, and must not call `extract_order`, because creating the order is what sends the bank details. See "A custom/event order is tendered to the kitchens" in `docs/OPERATIONS.md`.

**Order lifecycle.** `pending_payment` → `payment_proof_received` → `active` → `paused` → `completed`, plus the cancellation statuses. `orders.status` is the source of truth for payment and subscription state; `customer_state` is customer-level only (`new`/`ordering`/`lapsed`/`churned`) and must not mirror payment stages. **An unpaid order is overdue against its `start_date`, never against `confirmed_at`** — customers are told they may pay H-1, so `cancel-unpaid` only sweeps past the 16:00 deadline the day before the order's own first delivery. **Cancelling an order deletes its `daily_deliveries` rows from today onwards** (`deleteDelivery()`); neither kitchen sheet joins `orders.status` and neither may start, because the row's presence is the whole truth about whether the food is cooked. See `docs/OPERATIONS.md`.

**Delivery.** Senin–Sabtu, Minggu closed, libur nasional closed (`src/lib/holidays/id.ts` — extend before it lapses on 2026-12-31), **except the dates in `OPEN_DESPITE_HOLIDAY`, which the active kitchens work through** — always ask `isClosedHoliday()`, never `holiday.type`, or the prompt and the generator disagree and a customer is told no about food already on the sheet. Cuti bersama is an escalation, not a closure. Order deadline 16:00 WIB the day before (`settings.order_deadline_hour`), for changes and skips as well as new orders. The bot is handed the WIB clock and a computed "cutoff passed / still open" verdict plus the soonest deliverable date (`src/lib/time/jakarta.ts`) — never the bare hour, which it read as permanently still ahead. Areas come from active subcontractors' `delivery_areas`, never `settings` and never a literal in code, a prompt or a doc — read them with `activeDeliveryAreas(db)` (`src/lib/subcontractors/areas.ts`) or `useDeliveryAreas()` in the dashboard. They are **per kitchen, not global**, and some areas rest on a single kitchen, so deactivating one subcontractor can remove an area entirely.

**Sheet generation never writes a row an order has no unbooked quota for** (`unbookedByOrder()`) — without that guard an `active` order with a standing schedule generates rows past its package forever; 21 of 28 rows built for 2026-08-21 were already over-draws. See `docs/OPERATIONS.md`.

**Which order a delivery draws from is `pickDrawOrder()`, never query order** (`src/lib/orders/pick-draw-order.ts`): oldest active order with unbooked quota left (`unbookedByOrder()`, counted from the rows), else the newest active one. Never reintroduce a bare `.limit(1)` on active orders — 85 customers hold two or more at once. An order completes on what it has **delivered** (`orderRemainingToday()`), never on what it has *booked* — which hits 0 when the calendar fills — and never on the customer counter.

**`customers.portions_remaining` and `customers.avg_price_per_portion` are dead columns — never read them.** They are the unfinished half of migration 035 and disagree with reality for a third of customers. Every decision path counts the delivery rows instead; keep it that way. **And never floor a quota balance per order** — the June import's `package_size = 0` catch-all orders hold other packages' rows, so a per-order floor discards the over-draw and hands the customer someone else's portions; net bought against eaten at the customer level, as the ledger does. See "Those three columns are derived one way each" in `docs/OPERATIONS.md`.

**A delivery row means one thing: this food will be cooked and delivered. Present or absent, nothing in between** (migration 075). `daily_deliveries.status` and `orders.portions_remaining` are both gone. **Skipping is a `DELETE`**, never a status change — `deleteDelivery()` (`src/lib/orders/delivery-state.ts`) copies the whole row into `edit_log` first, because nothing else can rebuild it. Nothing else is written on a skip: the balance is `package_size` minus the rows that exist, so removing the row **is** the refund. Never "return the portions" to a counter, and never add a status column back — 2937 of 2937 rows only ever said `scheduled` while seven read paths each had to remember to exclude the values nothing wrote. Whether a delivery has happened is read off its date, never stored: `date <= today` is drawn, and `isLocked()` (past D-1 16:00) is when the kitchen is booked and the skip window has closed. The bot and the Assistant may delete a row only for a date whose cutoff has not passed.

**"Sisa kuota" is two numbers, both counted from the rows.** `remainingToday` (bought, not yet delivered — what a customer means) and `unbooked` (not yet on the calendar — how many more dates they may ask for). A customer whose whole package is already dated has 0 unbooked and a full balance still to eat, so never quote unbooked as a balance — use `remainingToday` from the order ledger or `loadCustomerSchedule()`. See "Sisa kuota" in `docs/OPERATIONS.md`.

**`orders.order_type` is gone** (migration 063), and **`orders.meal_time_preference` with it** (migration 077). Both were single-value summaries of a schedule, and a summary of a schedule goes stale against the schedule: the enum could not express Veronica's "Senin–Kamis dinner; Jumat & Sabtu lunch & dinner", and reading a delivery row against it produced a false bug report on food that was correct. The order carries **`requested_schedule`** instead — the actual days, `[{date, meal_type, portions}]`. Do not add a new flag.

**`delivery_schedule` is required on every `extract_order` call, and `[]` is the answer for a customer who books day by day.** A call that omits it creates nothing and sends no bank details — the bot asks which days and may call again. Nothing infers a schedule any more: `buildRecurringDeliveryRows()`, `portionsInRange()`, `FIXED_SCHEDULE_PREFS` and the Assistant's `create_order` tool were all deleted on 2026-08-28, because every one of them turned a meal-preference enum into dates nobody had confirmed. `isDeliveryDay()` (`src/lib/holidays/id.ts`) is what survives, and `mark_paid` filters the schedule through it so a Minggu or a libur nasional leaves its portions unbooked instead of reaching a kitchen sheet. See `docs/OPERATIONS.md`.

**Delivery rows land when the order is marked paid, never at creation** (migration 076), and `buildPaidDeliveryRows()` charges each one to the oldest package with balance rather than to the order being paid — a top-up's schedule is longer than its own package by whatever the customer still holds. `requested_schedule` is written once from the chat at order creation and read once by `mark_paid`, which turns it into rows; from then on the rows are the truth and nothing reads the column again. Rows used to be written at creation, and **nothing filters the kitchen sheet by order status** — `GET /api/deliveries/daily-sheet` keys on `delivery_date` alone — so three unpaid orders had 37 portions queued for a kitchen on 2026-08-28. Nothing derives a schedule any more: no inheritance from a previous order, no pattern invented at payment. A customer who names no days has `requested_schedule` null, gets no rows, and books one date at a time through `record_daily_order` — which is most of the book. **The bot must have the days before it calls `extract_order`**, because creating the order is what sends the bank details.

**The model still gets a turn after the welcome sequence, and that turn is given a job.** Everything has just been sent and the rules forbid repeating any of it, so without one the model fills the hole — an ad lead got twelve tokens of *"Aku cek dulu bentar ya kak"* and nothing after, because nothing schedules a second turn. `justWelcomed` makes the turn ask **one question that moves the order forward**. Do not "fix" this by skipping the model call: a first contact deserves a reply, and the same hole reopens for anyone who opens with "halo". See `docs/BOT_RULES.md`.

**A tool result must say what the tool actually did.** `handleToolUse()` returns `{ok, message|error}` and that is what reaches the model — never a fixed `"done"`, which let it confirm a booking that wrote nothing. Partial success names the dates it dropped. See "A tool result says what the tool actually did" in `docs/BOT_RULES.md`.

**One order per purchase, and the bot is the only thing that may create one.** `extract_order` amends the customer's open `pending_payment` order rather than inserting a second one. A reply that calls no tool no longer builds the order it implied — `flagOrderAtRisk()` pushes it to an admin and writes nothing. The path that did build it billed seven real customers for packages they already owned and forged a `delivered` row for a meal nobody cooked; no guard fixes that, because "16 porsi" in a chat cannot be told apart from scheduling sixteen already bought. Never wire an inference to `createOrderFromExtraction`. See `docs/BOT_RULES.md`.

**A package bought for someone else lands on that person, never on the buyer.** `extract_order` takes `beneficiary_name` + `beneficiary_phone`; the order and its deliveries go on the beneficiary and `orders.paid_by_customer_id` names the buyer. No phone number means no order — the bot asks, escalates and writes nothing. Never rewrite a beneficiary's customer record from the buyer's chat, and never apply a chat-derived size override to their order. `orders` now has **three** FKs to `customers`, so every embed needs an explicit hint. See `docs/OPERATIONS.md`.

**The 24-hour window is told to the customer, not hidden** (`src/lib/whatsapp/window-notice.ts`). And right now **every send that is business-initiated *because the window has closed* fails on `131042`** — the WABA has a payment restriction. **In an open window nothing is broken**, templates included: 30 delivery proofs sent 20–31 Agustus split 12 delivered/read against 18 failed exactly on whether the customer had spoken in the previous 24 hours, with no exceptions. So the fix for an unreachable customer is to get them to message us first, not to wait for the restriction to clear — which is what the manual number is for. The send endpoint still returns 200 `accepted`; the failure only arrives in the status webhook, so a successful POST is never proof the channel works.

**Roles.** `owner` (Justin ×2, Annie, Friska) has everything. `admin` — everything except Accounting and inbox takeover, and no hand-typing to a customer at all, enforced server-side rather than hidden — is currently held by nobody. **Revoking someone is two deletes, not one**: the `admin_users` row, *and* their Supabase Auth identity, because `getSessionWithRole()` falls back to `role: "admin"` for any signed-in email with no row, so the identity alone is a working admin login. Push sends filter on `admin_users.email`, so a person signed in as an address with no row silently gets no notifications. Who did what is in `edit_log` and, for hand-typed messages, `conversations.sent_by` — see "Who did what" in `docs/ADMIN.md`.

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

**The live queue is the `tasks` table, not a file.** Run `pnpm tasks` to print it (`pnpm tasks all` includes done, `pnpm tasks <area>` filters); admins edit it at `/tasks`. It holds the bugs with file:line pointers, what is blocked on Justin, and the deferred designs (Instagram generator, accounting phases 4–5, the `drawdown` naming refactor). Read it before picking up work. It replaced `TASKS.md` on 2026-08-25 — a doc only I could update, so it went stale between sessions and nobody but me could ever see it.
