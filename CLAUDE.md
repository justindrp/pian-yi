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
- **REQUIRED before every commit, no exceptions:** Update any affected root `.md` files (CLAUDE.md, DATABASE.md, API_ROUTES.md, DEV_REFERENCE.md, etc.) — edit the specific section the change affects. Never append a dated changelog entry at the bottom; always edit the relevant section in-place. These updates go in the same commit as the code change. If you skipped this, make a follow-up commit immediately.
- Version bumping is handled by a local `post-commit` hook (`.githooks/commit-msg`) — it amends the commit to include the bumped `package.json`. No GitHub Actions workflow involved.

When performing infrastructure work, prefer CLI calls over manual UI clicks so the actions are reproducible and auditable.

**Budget note:** Justin on $20/month Claude Pro plan — limited usage cap. Avoid spawning Agent/subagents for bounded, known-target tasks (single file, known symbol); do those inline w/ Read/Edit/Bash/Grep. Reserve Agent for genuinely open-ended multi-file research or when explicitly requested.

## Architectural principles

1. **HTTP 200 first, process after** — webhook returns 200 to Meta immediately, then processes async
2. **Idempotency everywhere** — every webhook event has a `message_id`, check against `processed_messages` table before processing
3. **Defense in depth** — 10 layers of cost protection (see "AI cost controls" in `DEV_REFERENCE.md`)
4. **Settings over hardcoding** — anything that might change goes in the `settings` table, edited via UI
5. **Server-controlled fields** — `id`, `created_at`, `updated_at`, `status`, `total_price` are always set by server, never accepted from client input
6. **Allowlist field updates** — when updating records, explicitly list permitted fields; never use mass assignment
7. **Sensitive fields in separate tables** — rate limits, flags, internal status live in tables users cannot edit
8. **Audit log append-only** — `edit_log`, `processed_messages`, `conversation_logs` are insert-only, never updated or deleted
9. **Never fetch a fixed window and aggregate in the browser** — "newest N rows, then group/filter client-side" silently drops data once the table outgrows N, and the UI gives no signal that it happened. Aggregate in the database (a view, or a query that returns the answer) and paginate with `.range()` when a list must be complete. This has already caused three separate bugs: `GET /api/orders` capped at 100 of 432 orders (twice), and the inbox capped at 500 `conversations` rows, which hid every lapsed customer's thread.

## Business rules

### Confidentiality (critical)

- **Never** disclose subcontractor names (Santapin, Thenie) to customers, in any form
- Frame as **"dapur partner kami"** (our partner kitchen). This used to read "dapur kami — implies internal operations", i.e. the goal was to make customers believe we cook in-house, which is what produced the bot answering "katering sendiri" and then flatly denying a named supplier. What is confidential is *which* kitchens, never that we work with kitchens at all. "Dapur kami" in passing is fine; using it to claim in-house cooking is not.
- **A customer who names a supplier gets neither a denial nor a confirmation.** We really do cook through partner kitchens, so "bukan kak, kami masak sendiri" is a lie the customer can find out — a worse outcome than the question. The rule (next to the "dapur kami" line in `system.ts`) is to say openly that we work with partner kitchens and keep which ones private: "Kami masak lewat dapur partner kak, cuma namanya memang nggak kami sebutkan ya." This replaced a flat-denial rule written on 2026-08-16 and reverted the same day for exactly that reason. Confidentiality here is about *which* kitchens, never about whether they exist.
- The prompt also says never to repeat back the name the customer used, and the model **does anyway** — under the denial rule it wrote "Santapin itu bukan bagian dari kami". Prompt text is not enforcement; a scrubbing guard on outbound replies is the durable fix and is not built yet.
- Customer-facing error messages are always generic; never leak technical details
- Never reveal COGS, profit margins, or internal operations
- **The account number is not in the model's context at all.** `buildSystemPrompt` deliberately fetches only `bank_name` — never `bank_account_number` or `bank_account_name` — because the payment message is composed and sent by `createOrderFromExtraction` (`src/lib/claude/extract-order.ts`), so the model has never needed them. It used to list the full number as plain business info, and on 2026-08-16 a simulated stranger with no order, no agreed price and no confirmation asked "rekeningnya berapa kak?" and got it. The prompt now states the number is sent automatically after confirmation and gives the deflection line; that is the second layer, not the fix. Do not re-add the number to the prompt — the "After order confirmation" section no longer carries the transfer template for the same reason.

### Language & tone

- All customer-facing messages in Indonesian only. Enforced, not just asked for: `looksEnglish()` (`src/lib/claude/language.ts`) checks every outbound webhook reply after the hallucination validator, and an English one is translated by Haiku rather than regenerated — the reply is usually correct and already matches whatever tool was called alongside it. The model slips mainly on the short sentence accompanying a tool call ("I'll send the menu image for you to check." in a 2026-08-15 simulator run). The check needs zero Indonesian markers and two English ones, so borrowed words customers use anyway ("next week", "cancel") never trigger a rewrite.
- `sanitizeReply()` (`src/lib/claude/sanitize-reply.ts`) runs last on every outbound webhook reply — after the validator, after the language guard — and the cleaned text is what gets saved, so the inbox shows what the customer actually received. It strips quotes wrapping the whole reply, drops a paragraph repeated verbatim, and cuts a leaked reasoning preamble. The leak is the serious one: `NO_THINKING` stops DeepSeek emitting a `thinking` block but not its deliberation landing in the text block, glued to the answer with no space after the full stop ("…no more than 200 words.Betul kak, …", 2026-08-16 simulator). `looksEnglish()` cannot classify those paragraphs — it returns `false` on any Indonesian marker and the deliberation quotes the customer's own words ("minggu", "kak") — so detection also matches the model talking to itself (`REASONING_OPENERS`: "Hmm", "Let me", "I should", …). If nothing survives as an answer the reply is returned untouched, leaving a genuinely English reply for the language guard. It also drops a **retracted false start** — the Indonesian sibling of that leak, which `REASONING_OPENERS` cannot see: asked for 13 porsi on 2026-08-16 the bot sent a wrong package list, cut itself off mid-number ("atau 14..."), then wrote "Sebentar, izinkan saya cek lagi." and answered again. Only unambiguous self-corrections match, and only with an answer after them — "Sebentar ya kak, saya cek dulu" is a real thing to say while asking an admin. Last, `**markdown bold**` is rewritten to WhatsApp's `*bold*`; the prompt has forbidden `**` since the formatting section was written and the model still emitted `**Rp 1.300.000**` two replies after `*Rp 420.000*`, so this is enforcement, not instruction.
- Use "kak" as honorific
- Bot replies under 200 words always
- Use emojis sparingly but warmly
- 50% of conversational messages should be casual (lowercase, no punctuation, no emojis) to feel human; transactional messages (order summaries, bank details, payments) must always be polished
- Contextual "ok" handling: post-delivery "ok" gets an enjoy-food reply; a generic affirmative "ok" gets a closing thanks only ("Baik kak, terima kasih ya 😊") — bot must not ask "Ada yang bisa kami bantu lagi?"

### Pricing

- Customer-facing chatbot prompt has the current Paket Personal S price list spelled out in `src/lib/claude/prompts/system.ts`; keep this in sync with `pricing_tiers` and `price_list_image_url`.
- Existing orders lock in `price_per_portion` at order creation time
- The inbox thread list reads the `inbox_threads` view (migration 059), which returns one row per customer holding their newest message, so every thread loads regardless of how old it is. The search box filters those loaded threads client-side, which is only correct because the list is complete — do not reintroduce a row limit on this query. See DATABASE.md for why this is a regular view and must not become a materialized one.
- Inbound WhatsApp media expires at Meta after roughly a week, so `media_id` is not a durable reference. The webhook now downloads the bytes at receipt time via `storeInboundMedia()` (`src/lib/whatsapp/media-store.ts`) into the private `chat-media` bucket and records the URL in `conversations.media_url` (migration 060). It is a separate column, not a rewrite of `content`, because `content` holds the caption / `[Dokumen: name]` label the bot reads back as context. A failed download is logged and the message is still saved — losing the copy must never cost the customer their reply. `getInboxImageSrc` / `getInboxDocument` read `media_url` first, then a `/chat-media/` URL in `content` (that is where `scripts/backfill-chat-media.ts` put it — it rescued 15 rows on 2026-08-12; 60 were already unrecoverable), then `media_id` as the legacy fallback. Payment-proof images take an earlier branch and keep their own copy in `payment-proofs`. For the ~60 rows whose media was already gone before the rescue, the `media_id` still resolves to a 404 — the `InboxImage` component catches the image's `onError` and shows "Photo expired — no longer available from WhatsApp" instead of a broken-image icon.
- Inbox liveness comes from a Supabase realtime channel plus a 10s poll, and the poll is the guarantee — Railway's proxy drops the websocket. Anything the UI must not show stale has to be reloaded in that poll's `refresh()`, not only in a realtime handler. Takeover state was stale for exactly this reason: `customer_flags` was subscribed to but never added to the `supabase_realtime` publication (fixed in migration 062), and `refresh()` reloaded threads and messages but not flags, so one admin taking over a thread left every other admin's header still offering "Take over".
- The admin inbox "Review extracted order" modal now shows server-computed `price_per_portion` and `total_price` before confirmation, but those values remain server-authoritative and are recomputed again on create.
- Manual inbox extraction now reads a deeper chat window (60 messages instead of 20) and includes saved learned-context notes in the prompt, so extraction still works after later back-and-forth pushes the original order form out of the most recent messages.
- Anthropic forced-tool extraction rejects conversations that end on an assistant turn; the inbox extraction path trims trailing assistant messages before calling Sonnet so old closed threads can still be parsed.
- The inbox extracted-order review modal supports two admin confirm modes: create the `pending_payment` order only, or create it and immediately send the payment-details WhatsApp message. The shared helper defaults to sending payment info unless the caller explicitly disables it.
- Manual order extraction now normalizes `package_size` to total portions when the chat clearly states a formula like `2 porsi x 5 hari = 10 porsi`, so the review modal prices recurring multi-portion orders correctly instead of treating day-count or per-delivery portions as the package size.
- Current S-only customer price thresholds (`pricing_tiers`): 5=29k, 6=29k, 10=28k, 12=28k, 20=27k, 24=27k, 40=26k, 48=26k, 60=26k, 72=26k, 120=25k, 144=25k per portion. The even sizes are the 6-day analogues of the 5-day ladder and carry the same per-portion price as the size below them.
- The only active subcontractor now delivers Saturday, so a weekly schedule runs 5 days (Senin–Jumat) or 6 days (Senin–Sabtu). The 6-day price rows on the public list are sellable again. Minggu is still closed, as are national holidays.
- **Which days those holidays are is data, not something the bot recalls: `src/lib/holidays/id.ts`** holds the 2026 SKB 3 Menteri list (17 libur nasional, 8 cuti bersama), and `describeUpcomingHolidays()` injects the next 45 days into the prompt. The prompt used to say "closed on all tanggal merah" without naming a single date, so the model had to remember mid-sentence: asked "besok bisa kirim ga kak?" on 2026-08-16 it answered "Bisa kak, besok kami tetap kirim", then wrote "17 Agustus itu Hari Kemerdekaan RI" two sentences later and reversed itself. The customer received all three stages. Most of the calendar is not recallable anyway — Idulfitri, Iduladha, Nyepi, Imlek and Waisak move with lunar calendars, the Easter-linked days move with Easter, and cuti bersama is set annually by decree.
- **Cuti bersama is not a closure — it is an escalation.** Justin's call: whether the partner kitchens work those 8 days depends on the kitchen, so the bot must neither promise nor refuse, and calls `ask_admin_for_help`. This is the one operational-status question it is allowed to escalate. The Idulfitri run (20–24 Maret 2026) is the heavy one: two libur nasional plus three cuti bersama.
- **The list ends at `HOLIDAYS_KNOWN_THROUGH` (2026-12-31) and must be extended each year.** The following year's SKB is normally published around September. Past that date `describeUpcomingHolidays()` returns null and the prompt tells the bot to escalate rather than treat an empty list as "no holidays coming" — but a whole year of dates silently missing is a real operational risk, so extending it is a calendar task, not a code task.
- Splitting a package's deliveries across two addresses on different days is operationally supported via the per-day address override on the daily sheet. 5 hari + 1 extra day is now simply a 6-hari package. There is still no single-portion one-off order — the smallest package is 5 portions, so an extra delivery on top of a package must draw from one the customer buys.
- Totals not on the size list but divisible by 5 or 6 are still sellable, priced at the per-portion rate of the **largest listed size below the total**, times the actual total. Examples: 15 porsi → 12's rate → 15 × 28k = Rp 420k; 25 porsi → 24's rate → 25 × 27k = Rp 675k; 50 porsi → 48's rate → 50 × 26k = Rp 1.300k. Totals that are neither on the list nor divisible by 5 or 6 must be rejected politely, **offering the nearest sellable total above and below — not the nearest list size**. Asked for 13 porsi on 2026-08-16 the bot offered 12 or 20, skipping 15: a size it prices happily when asked directly, but never volunteers as an alternative because the list is what it reads as the catalogue. That pushes a customer 7 portions past what they wanted instead of 2.
- **Never price an off-list total as repeated smaller packages.** That was the old fixed-schedule rule (15 hari = 3 × Rp 145k = Rp 435k) and it charged the small-package rate on a large order, so 25 porsi cost Rp 725k against 24 porsi's Rp 648k — Rp 77k more for one extra portion. The tier-below rule keeps per-portion price monotonically non-increasing as the order grows. This also unified the two ladders: the block rule used to apply only to fixed-schedule day counts while bebas refused anything off the list, so totals like 15 are now sellable to everyone (and cheaper than the old fixed-schedule price).
- Bulk adjust supported: `PATCH /api/settings/pricing` with `{ adjust: number }` increments all tiers at once
- Package sizes offered by the chatbot: 5, 6, 10, 12, 20, 24, 40, 48, 60, 72, 120, 144 total portions. The 6-multiples were added alongside Saturday delivery; the prices are spelled out in the "Package sizes and prices" section of `system.ts` and stored in `pricing_tiers`. Sizes off that list are priced by the tier-below rule above when divisible by 5 or 6, and refused otherwise.

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
- **`orders.order_type` is gone** (dropped in migration 063). It claimed to record a product choice — `recurring` vs `scheduled` — that never existed, and it did not even record that reliably: it defaulted to `'recurring'` on every insert, so 252 of 301 active orders said `recurring` while their `meal_time_preference` said `per_day_decision`. Every delivery-generating query filtered on `order_type = 'recurring'`, which left the daily sheet's Generate button one click from writing lunch *and* dinner rows for all 252. The only real question those filters asked — can this order's days be worked out without asking the customer? — is answered by `meal_time_preference`, via `FIXED_SCHEDULE_PREFS` in `src/lib/orders/build-recurring-deliveries.ts`. Use that; do not add a new flag.
- **Which order a delivery draws from is decided by `pickDrawOrder()` (`src/lib/orders/pick-draw-order.ts`), never by query order.** The rule is: the oldest active order that still has `portions_remaining > 0`; if none does, the most recently created active order. Four call sites previously queried `orders` filtered on `status = 'active'` with no `ORDER BY` and took the first row — `addable-customers`, `bulk-create`, daily-sheet POST, and the `generate-deliveries` cron. Postgres returns heap order, which is roughly insertion order, so the oldest active order won every time, including after it was fully drawn down and including when the customer had since bought a fresh package. Julian S is the case that surfaced it: order `eb853b86` (pkg 5) took 9 deliveries while `0831e475` (pkg 5, created nine days later) took 1, and only stopped winning when it flipped to `completed` and left the filter. 85 customers hold two or more active orders at once, so this was never a one-off. Do not reintroduce a bare `.limit(1)` or first-row pick on active orders.
- **Misattribution is only visible from the order side.** The customer ledger (`GET /api/customers/[id]`) sums every delivery a customer has without looking at `order_id`, so it balanced perfectly all through the Julian S bug. `GET /api/orders/[id]/ledger` shows one order's own credit and draws, so a delivery charged to an exhausted package reads as a running balance going negative. It is rendered in the Orders detail slide-over as "Draw history" and is the view to check after any bulk re-pointing of `daily_deliveries.order_id`.
- **`customers.portions_remaining` and `customers.avg_price_per_portion` are dead columns — never read them.** They are the unfinished half of migration 035, which set out to replace per-order balance tracking with a customer-level Weighted Average Cost model and never removed the thing it was replacing. Both models then ran at once with nothing keeping them equal: 65 of 333 customers had a wrong balance and 127 a wrong average price (one showing Rp 32.333, above any tier that has ever existed; several negative, which the `> 0` render silently hid as "—"). Six code paths wrote them; a single cell on the Customers page read them. That cell now derives both from the customer's open orders (`active` / `paused` / `payment_proof_received`, `portions_remaining > 0`), so the page agrees with Orders and the customer ledger. The columns still exist and are still written — dropping them is gated on the reconciliation chain, because 27 customers hold a cached balance with no order behind it (Michelle Nathania's 30 portions being the largest) and deriving turns those to 0. Every decision path already reads `orders.portions_remaining`; keep it that way.
- **`customers.phone_number` is canonical `+62...` and unique** (partial unique index, migration 065, skipping `IMPORT_` slugs). It previously had neither normalization nor uniqueness, so the same person existed twice as `+628...` and `628...`: the WhatsApp flow created one row on 2026-06-08 and `fix-no-orders.ts` created a second on 2026-07-07, each unaware of the other. Orders landed on one row and deliveries on the other. This is what made the ORDER_HARIAN audit report 135 missing deliveries — matching sheet names to a single customer id picked the empty twin. The real number is 5 (Elaine 3, Daryn Dior 1, rudy 1). `scripts/dedup-phone-format.ts` merged the 11 groups on 2026-08-14, re-pointing `orders`, `conversations`, `daily_deliveries`, `broadcast_recipients` and `delivery_proofs.matched_customer_id`, dropping the duplicate's `customer_flags` / `customer_state` / `customer_rate_limits` rows, then deleting the emptied row. It never deletes deliveries — the older `scripts/dedup-customers.ts` does, and is only correct for `IMPORT_` placeholders.
- **The 2026-06-08 import invented placeholder orders** — fixed 2026-08-14 by `scripts/fix-placeholder-orders.ts`. Defi Lugito (`pkg=16`), Valen (`pkg=45`, exactly the sum of her two real orders) and Darren (`pkg=18`) each carried a fabricated order on the WhatsApp row that is in no sheet, while their real purchases sat on the duplicate row. Merging the duplicate rows made both sets count as purchases and *masked* the overdraw, which is why any bought-vs-drawn figure taken between the merge and this fix is wrong. The placeholders are deleted, every delivery re-pointed to a real order by the `pickDrawOrder()` rule, and Darren's real June package (30 porsi, Rp 790.000 @ 26.333) written for the first time. Verified balances: Defi 100/106 = −6, Valen 45/49 = −4, Darren 30/33 = −3. Darren also held copies of Darren Dior's 10 March deliveries, deleted the same day.
- **Darren, Darren Dior and Daryn Dior are three different people.** Darren (`+6281262652288`) bought his own 30-porsi package in June. Darren Dior draws from his sister Daryn Dior's 16-porsi order `26744cb1` via `customers.linked_order_id` — his 10 March deliveries plus her 6 are that one package, so neither is an overdraw. `scripts/fix-linked-order-draws.ts` wired this up on 2026-08-14 — his 10 rows and her 5 now draw from `26744cb1`, leaving it at `rem = 1`. Before that his rows drew from his own `pkg=0` import artifact `2b9d5067` and hers from artifact `feb481a3`, so the real order sat untouched at `rem = 16` and both siblings read as overdraws. Both artifacts are now empty and are left in place for the wider ghost-order cleanup. Her sheet shows 6 deliveries against 5 in the database — that missing row is the "Daryn Dior 1" in the ORDER_HARIAN audit's remaining 5, and it would take `26744cb1` to exactly 0.
- **Only `addable-customers` honours `linked_order_id` when choosing a draw order.** The daily-sheet POST, `bulk-create` and the `generate-deliveries` cron all call `pickDrawOrder()` on the customer's own orders, so a new delivery for a linked customer charges their own (usually `pkg=0`) order rather than the package that actually covers them. Only Darren Dior is linked today, and he has not ordered since March, so nothing is currently mis-drawing — but any new linked customer will need the other three paths fixed.
- **An order is completed on its own `portions_remaining`, never on the customer counter.** `deduct-daily-quota` used to key completion on `customers.portions_remaining` and close *every* active order a customer had the moment that counter reached zero. The counter was only ever credited by `POST /api/customers/free-quota` — `POST /api/orders` set `orders.portions_remaining` and left the customer counter alone — so a purchased package left it at 0, `Math.max(0, 0 - n)` read as "exhausted", and the order closed with its package untouched. Jordy's 5-porsi order was completed on 2026-08-13 holding 4 portions, which blocked his next delivery behind the "Customer has no active order" guard. Fixed both ends: the cron now deducts per order first and completes only orders whose own balance hits ≤ 0, and order creation credits the customer counter (and debits it again for backfilled past slots). Three orders were reverted to `active` by hand — Jordy (4), Nicholas Satria (2), Cindy Angelia (1). Seven other `completed`-with-balance orders carry `completed_at = null` and came from import scripts, not this bug.
- No draw path checks the balance before writing, so a fully-used order can still go negative. The reconciliation ran on 2026-08-13 (`scripts/reassign-draw-orders.ts --apply`): 805 deliveries re-pointed by FIFO and 84 `portions_remaining` counters recomputed from actual draws. Of 289 active orders, 209 now read ≤ 0 and **28 are strictly negative** — the ≤ 0 count went *up* from the pre-run 89 because most of those are fully-drawn orders that correctly read exactly 0 instead of a stale positive. The 28 are genuinely over-delivered. A hard reject in daily-sheet `PUT` is now unblocked for the reconciled set, but 72 customers holding a `package_size = 0` order were excluded from the run and must be backfilled first, or the guard will reject their legitimate deliveries.
- Auto-generation (`generate-deliveries` cron, daily-sheet POST) now only touches orders whose `meal_time_preference` is a standing pattern. `per_day_decision` / `custom_schedule` / null orders get delivery rows only when a human writes them, which is what every bebas customer already relies on.
- `delivery_route` (groups the Daily Sheet into Route 1 / Route 2) is computed via a single shared helper, `getDeliveryRoute()` in `src/lib/utils/format.ts` (area→route map: Alam Sutera/BSD Lama → 1, Gading Serpong/BSD Baru/Karawaci → 2), used on both write paths that can set a customer's area — manual customer creation and WhatsApp onboarding
- **Subcontractor daily bill** (`/dapur/[id]`, `src/app/dapur/[id]/page.tsx`): the summary card shows what we owe the kitchen for that day, broken down by meal (Makan Siang / Makan Malam) then by route, with the rate printed (`18 × 19.500`) so the kitchen can check the arithmetic. Rates come from `subcontractors.cost_per_portion_route1` (Route 1 — our own courier, so cheaper) and `cost_per_portion` (Route 2 — the kitchen delivers); a null `cost_per_portion_route1` means one rate for both routes. Never hardcode 19.500 / 21.000 — those are Thenie Catering's current values, editable on the subcontractor form. Portions on an order carrying `orders.addon_cost_per_portion` bill at route rate + addon, so one route can print two rate lines ("2 × 21.000 + 1 × 26.000") — the same grouping the COGS journal does. The page is **public and unauthenticated**, so anyone with the URL sees these per-portion costs; that is intended (the kitchen is the audience) but is why customer prices must never be added to it.
- **Add-ons (nasi merah and the like) are two separate numbers.** What the kitchen charges us extra goes in `orders.addon_cost_per_portion`; what the customer pays is already inside `orders.price_per_portion`, because we charge the add-on through at cost. Cindy Angelia's order `6cd37e43` is the worked example: 34.000 = the 5-porsi tier 29.000 + 5.000 nasi merah, with `addon_cost_per_portion = 5000`. Only the customer half was set at order time, so every COGS journal for her portions posted at flat 21.000 and understated cost by 5.000/porsi (the 12–14 Agustus journals are still wrong — journals are idempotent on `source_id` and there is no reverse-entry action yet). The field has **no UI and no API allowlist entry** — it is set by hand in the database, and it is per order, so a customer's next package needs it set again.
- Address/area is customer-level data — `orders` has no address columns. Order pages/APIs read delivery area/address via join on `customers`. A customer move goes in `address_2`, not a new order-level snapshot. `price_per_portion`/`total_price` remain order-level (locked at creation).

### Order flow stages

`pending_payment` → `payment_proof_received` → `active` → `paused` (optional) → `completed`

Cancellations: `cancelled_unpaid`, `cancelled_by_customer`, `cancelled_by_admin`, `refunded`

`orders.status` is the source of truth for payment/subscription/order lifecycle as soon as an order row exists. `customer_state` is customer-level only (`new`, `ordering`, `lapsed`, `churned`) and should not mirror payment stages.

Payments page owns the payment queue: Awaiting payment lists `pending_payment`, admins can manually advance those rows to `payment_proof_received`, and Pending verification is where they run `mark_paid`.

Orders page status dropdown defaults to "Active" and has no unfiltered view by default — an explicit "All" option (empty status, no `.eq` filter applied) was added alongside the per-status options so admins can see orders in any stage.

Orders table sorts on two columns: "Start date" and "Created" (`created_at`). Clicking a header sorts by that column; clicking the active header flips direction. Only the active column shows an arrow. Default is Start date descending. The "Created" column exists to line orders up against the `package_orders` Google Sheet during data reconciliation. The leading "No." column is the row's position in the current filtered+sorted view (`index + 1`), not a stored per-order number — it always restarts at 1 and renumbers whenever the sort or filter changes.

### Meal time preference types

- `lunch_only`
- `dinner_only`
- `both_fixed` (e.g., 1 lunch + 1 dinner daily)
- `per_day_decision` (customer messages each day)
- `default_lunch` or `default_dinner` (default with ad-hoc overrides)
- `custom_schedule` (JSON with per-weekday preferences)

### Ordering flow (chatbot)

- **There is one product: a paket porsi (a quota of portions).** Q0 ("jadwal tetap atau pesan bebas?") is gone from `system.ts` — it asked customers to pick a product that does not exist. Both paths always priced identically (`package_size × price_per_portion`), and the data said customers ignored the distinction anyway: 78% of orders booked a block of days upfront regardless of which one they chose, and only 2 of 51 sampled orders were genuinely decided day by day. Never reintroduce the question.
- Whether a customer's days are booked ahead is a **scheduling detail asked after the price is agreed**, not a product choice: "Mau sekalian saya jadwalkan hari-harinya kak, atau pesan bebas aja per hari?" Skip it entirely if they already described a schedule. It does not change the price.
- The bot asks days / meal-preference / portions-per-delivery / kitchen as one combined message instead of one-at-a-time, to cut WA round-trips. It re-asks only whichever field the customer didn't answer.
- One order form for everyone. The four scheduling fields at the bottom (meal preference, porsi per pengiriman, tanggal mulai, tanggal selesai) are optional and dropped entirely for a customer ordering bebas — their absence is not a missing field.
- Relative date phrases ("senin depan", "besok", "lusa") must resolve to the nearest upcoming occurrence from Today, not one cycle further out; an explicit date the customer states later always overrides the bot's earlier interpretation of a relative phrase — the bot must never silently "correct" a date the customer already confirmed.

### Weekly menu

- **Which week an image covers is stored, not inferred: `subcontractors.menu_week_start`** (migration 066), the Monday of that week. Nothing recorded it before, so the prompt and the `send_menu_image` tool description both flatly asserted the stored image was always the *current* week — false from the moment the next batch is published. On Saturday 2026-08-15 Vania asked for next week's menu while Batch 50 (17–22 Agustus) was already uploaded; the bot told her it wasn't out yet and to come back Friday, and Agnes sent it by hand.
- Publication is nominally Friday but not reliably so — Batch 50 went up on a **Thursday**. `defaultMenuWeekStart()` (`src/lib/menu/week.ts`) therefore defaults Thursday-onward uploads to next week, and that is only a default: the value is editable on the subcontractor form ("Menu week"), because whoever uploads the image is the only one who actually knows. Never re-derive the week from `updated_at`.
- **A week is always named to the customer as its full Senin–Sabtu span**, via `formatMenuWeekRange()` ("Senin 17 – Sabtu 22 Agustus 2026"). The prompt used to interpolate the bare Monday, and the bot echoed that single date as the extent of what it held: "Baru sampai minggu depan (Senin, 17 Agustus)" on 2026-08-16, for an image covering 17–22 Agustus. Each branch also states the span explicitly and tells the model never to give only the first day.
- `describeMenuWeek()` turns the stored date into `current` / `next` / `past` / `unknown` relative to today (Jakarta), and `describeMenuWeeks()` collapses the active kitchens — **any disagreement or missing value yields `unknown`**, which tells the bot to make no claim about which week it holds. The prompt has one branch per relation: send it as next week's when it is next week's, refuse-and-say-Friday when it is genuinely only the current week, `ask_admin_for_help` when stale or unknown.
- Asked about next week's menu before it is out, the bot says it isn't up yet and goes live Friday. It must never send an image as a week it does not have — on 2026-08-13 it answered "menu minggu depan udah ada kak" while attaching Batch 49 (10–15 Agustus, the current week).
- **The week after the one on file is named and refused explicitly.** The prompt's every branch ends with the span `weekAfter()` produces ("minggu depannya lagi", "dua minggu lagi", Senin 24 – Sabtu 29 Agustus 2026) and the instruction not to answer it with the image on hand. Without it the bot treated "minggu depannya lagi" as a synonym for next week and offered Batch 50.
- `send_menu_image` sends every **active** kitchen's image. The `is_active` filter is load-bearing: inactive kitchens keep a stale `menu_image_url` indefinitely, and without it the same reply carried Batch 49 and Batch 39 (1–6 Juni) from a kitchen retired in June.
- **The model must never see a media URL as message text.** Every image we send is saved to `conversations` with the raw file URL as its `content` — the inbox renders from that. `loadHistory` fed it back verbatim, so the model's own history contained assistant turns that were nothing but a Supabase storage link, and on 2026-08-16 it copied the pattern: "Tentu kak, ini dia menu untuk minggu depan ya:" followed by the bare URL as text, with no `send_menu_image` call. The customer got a link to open by hand. `historyContent()` (`src/lib/claude/conversation.ts`) now replaces the content of an `image` / `document` row with a placeholder **only when the content is itself a bare link** — captions, `[Bukti pembayaran dikirim]` labels and maps pins pasted as text messages must survive, since the order form is filled from them. The prompt rule ("never write an image URL or any link") is the second layer, not the fix.

### Confidentiality flow for subcontractor issues

When subcontractor is unavailable, use template: "Halo kak, mohon maaf dapur partner kami yang biasanya besok libur, besok kita akan kirim dari dapur yang satunya lagi"

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

- `/api/auth/check-admin` — no session verification, allows unauthenticated admin email enumeration. Fix: extract email from verified Supabase session instead.
- `supabase/seed.sql` may still reference old `"BSD"` area string (not yet split into BSD Baru / BSD Lama).
- **Delivery proof auto-send (TODO):** call `sendDeliveryPhotoToCustomer(proofId, customerId)` directly in the POST route instead of the current "Ready to send" UI step.
- **Accounting Phase 4 (TODO):** "Balik jurnal" reverse-entry action — post mirror entry (swap debit/credit), link via `reversed_journal_id` on `journals`. `source_type: "manual"` only; auto-posted entries stay locked.
- **Accounting Phase 5 (TODO):** CSV export for journals/ledger (`?export=true`) + quick-expense form (auto-build 2-line balanced journal from account + amount).
- **Instagram daily post generator (deferred, designed 2026-08-16):** one auto-generated post per day. Shape: `instagram_posts` table keyed `scheduled_for date UNIQUE` (that index is the idempotency guard), two jobs in the existing in-app scheduler (generate ~07:00 for tomorrow, publish ~11:00 today, both `catchUp: true` same-day), a public `instagram-media` bucket because Meta fetches the image by URL, and an `/instagram` review page. Store `ig_creation_id` between the two Graph calls — a retry after a partial failure must resume at publish or it double-posts. **The long pole is not code:** the Content Publishing API needs `instagram_content_publish` + `instagram_basic` through Meta App Review, and a Business/Creator IG account linked to a Facebook Page. Reuse the existing WhatsApp Meta app (already business-verified) and a Business Manager **System User** token, which does not expire. Open questions when resumed: AI-generated food imagery vs AI backgrounds behind real photos (the food we sell should not be a picture of food that never existed, and Meta labels AI images), auto-publish vs approve-first, and which image vendor.
- **Domain naming refactor (deferred, big):** `order` = prepaid package everywhere; daily portion-draw has no clean name. Preferred fix **(A)**: add `drawdown` as the daily-draw layer name, all existing `order` refs stay. High-risk fix **(B)**: rename package → `package_order`, daily draw → `order` — huge blast radius across tables, routes, tools, chat, accounting descriptions.
- **Overdraw: 32 customers have drawn 178 more portions than they bought** (`OVERDRAW.md`, regenerate with `scripts/export-overdraw.ts`). No draw path checks the balance before writing. Verick (83), Kiliang (11) and Kevin M (8) have zero purchases on file and are the pre-December sheet gap, not grants; Gaylen (1) is the influencer barter deal. Darren Dior is *not* on this list — he draws from his sister Daryn's order via `linked_order_id`, which the report now folds together. The customers overdrawn by only 1–2 portions are the missing guard, not deliberate free quota. Free-quota orders for the rest are pending Justin's per-customer verification of what was actually granted — do not create them speculatively.
