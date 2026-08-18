# Dev Reference

On-demand reference — read when working on the relevant area, not loaded every session.

## AI cost controls (10 layers)

1. **Anthropic console budget cap** — $100/month hard limit, configured outside this codebase
2. **API key hygiene** — keys only in `.env` and Railway env vars, never committed
3. **Per-customer rate limits** — 40 bot replies/day, 9 bot replies/minute, 200,000 tokens/day per customer, enforced by `checkRateLimit()` in `src/lib/claude/safety.ts`. Exception: messages while a customer is `awaiting_payment` bypass this gate, so payment and proof-of-payment follow-up can continue even after the usual limit is hit. **`checkRateLimit()` increments the counter as a side effect, so it must be called exactly once per inbound message.** The webhook used to call it twice — once in `processWebhookAsync` and again in `processSavedCustomerMessage`, which the first always calls — which silently halved the daily cap to 10 real messages and cut off customers mid-order. The single remaining call lives in `processSavedCustomerMessage`, which is both the gate on the Sonnet call and the only gate on the `replay-latest` path. It must stay above `analyzeCustomerMessage()` there: that is a Haiku call, and a rate-limited customer should not cost a model call at all.
4. **Token budget per request** — max 20 messages from history, max 4000 input tokens, max 1000 output tokens, max 3000 token system prompt
5. **Loop prevention** — idempotency, circuit breaker (stop calling Claude for 5min if 5 errors in 60s), echo detection (don't send duplicate replies), retry budget (max 3 retries per message)
6. **Burst coalescing** — an inbound message waits `BURST_WINDOW_MS` (15s, `src/app/api/webhook/whatsapp/route.ts`) and is dropped if a newer one from the same customer arrives meanwhile; only the last message of a burst is answered. Customers type one thought per message, and the webhook otherwise treats each as its own turn — Cindy's four-message complaint on 13 Aug 2026 drew four separate apologies, four model calls, in 50 seconds. Echo detection cannot catch this: `detectEcho()` compares the previous reply exactly, and four differently-worded apologies are not equal strings. History loads *after* the wait, so the surviving call sees the whole burst and answers all of it at once. Only the live webhook opts in (`coalesceBurst: true`); replay and draft paths answer the message the admin picked, immediately.
7. **Prompt injection defense** — system prompt forbids long/repetitive responses, hard `max_tokens` cap, pattern detection before calling Claude
8. **Model routing** — the "Sonnet" role (full conversational responses) and the "Haiku" role (photo matching, classification, sentiment, any preprocessing step) are separate constants, so they can point at different models. In production both are `deepseek-v4-flash`; see the AI line in `CLAUDE.md`.
9. **Monitoring** — dashboard widgets for spend/tokens, push notifications on anomalies, daily 9am digest email
10. **Kill switch** — toggle in Settings to disable AI chatbot entirely

## Reading model responses

`ANTHROPIC_BASE_URL` and `CLAUDE_SONNET_MODEL` / `CLAUDE_HAIKU_MODEL` can point the app at an Anthropic-compatible provider, so the model answering may be a **reasoning** model even though the code says "Haiku". That changes the response shape in two ways, and both have already broken a feature in production:

- **The first content block is `thinking`, not `text`.** `response.content[0].type === "text"` is then false and the caller sees an empty reply while the answer sits in a later block. Never index `content[0]`. Use **`extractText(response)`** from `src/lib/claude/client.ts`, or **`extractJson(response)`** when the result gets `JSON.parse`d — that one also strips the ```` ```json ```` fence a reasoning model tends to wrap JSON in. Every call site now uses them; tool-use call sites (`analyze-customer-message`, `extract-order`, `assistant`, `chatbot-simulator`) were already safe because they select blocks with `.find`/`.filter` by type.
- **`max_tokens` is spent on thinking first.** `learn-context` asked for 300, the thinking block consumed all of it, and the call returned `stop_reason: "max_tokens"` with zero text — surfacing in the inbox as "Could not summarize conversation". Budget for the thinking, not just the answer: no call may ask for a budget that only fits the answer. The one-word classifiers were the worst offenders (`classifier` at 20, `classify-address` at 10, sentiment at 50 — all raised to 500). This raises a ceiling, not typical spend: a non-reasoning model still emits one word and bills for one word.
- **A tool call may arrive with no text beside it.** Anthropic models answer and call a tool in the same response, so the webhook read `replyText` and `toolUse` out of one round trip and never called back. A reasoning model spends the turn on `thinking` + `tool_use` and emits no text — nondeterministically, which is why it looked random. The tool ran and the customer heard nothing; when the tool was a no-op (`send_menu_image` on an already-sent menu) the whole message vanished. `processSavedCustomerMessage` now runs the tool first, then, **only when there is no text**, sends the tool result back for the reply that should have accompanied it. The normal path still costs one call. Silence is never acceptable on this path: the no-text-no-tool case logs `stop_reason` plus block types and raises a high-priority admin push instead of returning quietly.
- **Thinking is now switched off at every call site.** Spread `NO_THINKING` from `src/lib/claude/client.ts` into every `messages.create` call — it sends `thinking: { type: "disabled" }`. DeepSeek reasons by default at effort "high", and the three failures above are all downstream of that. Verified against `https://api.deepseek.com/anthropic`: with it, a reply is a single `text` block and a tool turn is `text` + `tool_use`; without it, both carry a leading `thinking` block. DeepSeek's thinking-mode guide gives `{ reasoning: { effort: "none" } }` as the Anthropic-format toggle — that form is accepted and silently ignored, so do not use it. The defensive handling above stays: the switch can be undone by a provider change, and `extractText` costs nothing.
- **Mocking the client in tests** must spread `jest.requireActual("@/lib/claude/client")` before overriding `getAnthropicClient`, otherwise `extractText`/`extractJson` are undefined inside the module under test and every call fails into its catch branch.

## Performance principles

- **Database indexes** on every column used in WHERE/JOIN/ORDER BY (especially `phone_number`, `message_id`, `status`, `created_at`)
- **Pagination** on all list endpoints, default 20 rows
- **`Promise.all`** for parallel queries when loading multiple datasets
- **TanStack Query** for client-side caching, optimistic updates, stale-while-revalidate
- **Skeleton loaders** for any data fetching, never blank screens
- **Settings/templates cached in-memory** on the server, refresh every 60s
- **Co-locate Railway and Supabase in Singapore region** for low latency

## Push notifications (web-push)

VAPID keys stored in env vars. Subscriptions stored in `push_subscriptions` table, one row per browser/device (`endpoint` is the conflict key).

Subscription state is per-device, never per-user: `PushSubscribeButton` reads `pushManager.getSubscription()` first and only hides itself when the server also knows that exact endpoint. If the browser holds a subscription the DB lost, the button re-POSTs it to `/api/push/subscribe` silently. iOS requires the PWA be opened from the Home Screen (standalone) before `pushManager.subscribe()` will work.

Threads in takeover (`escalated_to_human`) take an earlier branch in `processWebhookAsync` that never reaches that push, so they need their own — "New message — you have this thread", high priority, sent for **every** inbound message. It was previously in the `else` of a message-type check, so images and locations notified but plain text did not, which is nearly all traffic. On an escalated thread the bot is silent by design, so the admin who took it over is the only person who can reply; not telling them is how threads go quiet for days. `analyzeCustomerMessage` is not a substitute — it only surfaces anything when it proposes a write action.

### Handing a thread back to the bot

`escalated_to_human` has no expiry of its own, and admins routinely forget to press "Resume bot" — most threads ever taken over never went back to the bot at all. Two paths clear it, both reading `TAKEOVER_INACTIVITY_MINUTES` (30) from `src/lib/customers/takeover.ts` so they can never disagree:

1. **Inline, in `processWebhookAsync`** — evaluated *before* the `escalated_to_human` branch. If the customer writes and the last admin activity is older than the timeout, the flags are cleared and the message falls through to the normal bot flow, so the bot answers that same message instead of the customer waiting for a sweep.
2. **`GET /api/cron/auto-resume-bot`** — the backstop for threads whose customer never writes again. Runs every 15 min from the in-app scheduler. Path 1 is deliberately independent of it and covers every thread that is actually alive, which is why the takeover system kept working through the years the scheduling was broken. The route processes at most `BATCH_SIZE` (10) candidates per run, oldest first, and clears each customer's flags immediately after that customer's context lands — a 30-row backlog took over two minutes of Claude calls and was cut off by Railway's proxy, so a run must never be able to grow without bound.

   Resuming a thread is not the same as answering it, and for a long time the cron only did the first. A customer who wrote *during* the takeover — often seconds after the admin's last message, which is exactly when path 1 correctly declines to cut in — was left with no reply at all: the flag cleared silently and nothing spoke. The only thing that ever replayed that message was the admin inbox in a browser (`inbox-client.tsx`, on a `blocked → unblocked` transition), which requires an admin to have that exact thread selected at the moment the flag flips. Cindy Angelia's 13.22 message on 2026-08-13 was answered at 21.03, when a human finally opened the thread. The cron now calls `replayLatestCustomerMessage` after each successful resume.

Both call `tryLearnCustomerContext` before clearing, so whatever the human said is folded into the customer's notes before the bot picks the thread back up. Neither touches a row whose `last_human_activity_at` is NULL — with no clock there is no way to tell "handled a minute ago" from "abandoned in June".

The "New message from X" push is sent in exactly one place — `processWebhookAsync`, before it hands off to `processSavedCustomerMessage`. Do not add one to `processSavedCustomerMessage`: it runs on the same inbound message right after, and `/api/inbox/replay-latest` runs it again over a message the admin is already reading. Having it in both is what made every message notify twice.

Priority levels:

- **High**: complaints, escalations, API errors, kill switch triggered, fraud/spam detected
- **Medium**: payment proof received, order modifications, large new orders, low-confidence photo matches
- **Low**: routine new orders, renewal reminders sent, daily delivery sheet ready (digest)

## Folder structure

```text
pian-yi/
├── CLAUDE.md (project rules, read every session)
├── API_ROUTES.md (endpoint-level reference, read on demand)
├── DEV_REFERENCE.md (this file, read on demand)
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
│   │   ├── dapur/[id]/ — public, auth-free mobile page per subcontractor: tomorrow's delivery orders + that day's bill (see CLAUDE.md "Subcontractor daily bill")
│   │   ├── privacy/ (public privacy-policy page)
│   │   └── api/ — route handlers; see API_ROUTES.md for endpoint-level detail
│   │       ├── webhook/whatsapp/ (Meta webhook: main chatbot entry point)
│   │       ├── cron/ (Railway cron targets: reminders, cancellations, digests, delivery-gen)
│   │       ├── push/ (VAPID config, subscribe, test push)
│   │       ├── auth/ (admin email check, signout)
│   │       ├── dashboard/ (KPI metrics endpoint)
│   │       ├── orders/, customers/, deliveries/, subcontractors/, settings/, reports/ (CRUD for each dashboard page above)
│   │       ├── inbox/ (bot-reply, learn-context, pipeline-stage, replay-latest, delivery-proofs proxy)
│   │       ├── broadcasts/ (preview + send)
│   │       ├── assistant/ (agentic chat + stream + execute + daily-brief claim + conversation threads)
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
│   │   │   ├── language.ts (Indonesian-only guard: looksEnglish + Haiku translate)
│   │   │   ├── sanitize-reply.ts (last pass: unquote, dedupe, cut leaked reasoning)
│   │   │   ├── learn-context.ts (Haiku auto-summarizes durable customer notes)
│   │   │   ├── assistant-prompt.ts (system prompt for the Admin Assistant)
│   │   │   ├── assistant-tools.ts (Admin Assistant's read/write tool definitions + handlers)
│   │   │   ├── assistant-steps.ts (human-readable labels/summaries for streamed tool calls)
│   │   │   └── assistant-history.ts (Admin Assistant conversation thread persistence)
│   │   ├── whatsapp/ — Meta Cloud API integration
│   │   │   ├── client.ts (send messages, typing indicators)
│   │   │   ├── webhook.ts (HMAC signature verification for inbound webhooks)
│   │   │   └── types.ts
│   │   ├── holidays/
│   │   │   └── id.ts (2026 SKB libur nasional + cuti bersama; feeds upcoming closures into the prompt)
│   │   ├── accounting/
│   │   │   └── journal.ts (post balanced journal entries: revenue/COGS, mark-paid, free-quota)
│   │   ├── grants/
│   │   │   └── parse-paste.ts (spreadsheet paste → free-quota rows; name/phone matching, refuses ambiguous names)
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
│   │   │   ├── customers-client.tsx (customer list, detail panel, free-quota grant batch table)
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
│   │   │   ├── assistant-client.tsx (streaming agentic admin chat UI: live text + tool steps, Stop button, write tools w/ confirm step)
│   │   │   └── assistant-widget.tsx (floating shortcut into the assistant, embedded on other pages)
│   │   └── shared/ (cross-page components: mobile nav, query provider, service worker registrar)
│   └── types/
│       └── database.ts (generated by `supabase gen types`)
└── scripts/
    ├── audit-sheet-data.ts (re-runnable data audit; scans CUSTOMERS/ORDER_HARIAN/package_orders sheets vs the DB customers table → writes DATA_AUDIT.md listing name mismatches (with "did you mean" suggestions), orphan purchases (package_orders rows with money/portions but blank name), blank-name deliveries, and zero/typo values. Run: `set -a && . ./.env.local && set +a && pnpm tsx scripts/audit-sheet-data.ts`)
    ├── first-appearance-2025.ts (re-runnable; reads the Sep–Dec 2025 delivery sheet, tab gid 650194403 on the same spreadsheet, and writes FIRST_APPEARANCE_2025.md — each name's first and last delivery date, delivery count, and paid/free row counts, sorted by first appearance, plus new-names-per-month and a "possible same person" spelling-similarity list. Built to reconstruct `package_orders` for that period, where the only other record is BCA transaction history whose payer names are often the customer's parents. Read-only: hits no database. Run: `pnpm tsx scripts/first-appearance-2025.ts`)
    ├── import-customers-orders.ts (re-runnable Google Sheets → Supabase import; fetches CSV directly via export URL, upserts customers by phone_number, skips orders for customers that already have active orders. Flags: `--skip-customers` (build name→id maps from DB, import deliveries only), `--after=YYYY-MM-DD` (only ORDER_HARIAN rows after date), `--until=YYYY-MM-DD` (only ORDER_HARIAN rows through date — pairs with `--after` so post-cutover deliveries, which live only in app-entered `daily_deliveries`, aren't double-imported), `--reconcile` (recompute every customer's remaining quota = Σ package_orders.Porsi − Σ [ORDER_HARIAN through the cutover + daily_deliveries after it]; writes customers.portions_remaining/avg_price + the customer's oldest active order's package_size/portions_remaining/price/total; skips overwriting a customer whose only post-cutover order already has a real non-zero package_size — in-app entry wins over stale sheet data; never touches status/customers/journals), `--dry-run` (with --reconcile: print per-customer pkg/delivered/remaining diff table + unmatched-name warnings, write nothing). Three sheet tabs on one spreadsheet: CUSTOMERS gid 1454452383, ORDER_HARIAN gid 1975392427, package_orders gid 341974326.)
    ├── dedup-customers.ts (one-off: merges duplicate customers created when an import ran with a real phone against an existing `IMPORT_<slug>` placeholder from a prior run — reassigns orders, deletes the placeholder)
    ├── test-webhook.ts (`pnpm test:webhook "<message>" [phone]` — simulates an inbound WhatsApp message against the local dev server with a valid HMAC signature)
    ├── sim-multi-day.ts (re-runnable; replays Tio Jason's 18 Agustus conversation against the live prompt and the fixed `record_daily_order` schema, printing **every** `tool_use` block with its input and a count of dates booked across the whole conversation. Written to prove the multi-day fix: the old code kept only the last tool block and the tool took one date, so an eight-day run booked one delivery. `--rem=N` sets the simulated quota, so the "never agree to more days than the quota covers" rule can be exercised; extra args replace the scripted turns. Run: `set -a && . ./.env.local && set +a && npx tsx scripts/sim-multi-day.ts [--rem=N] [YYYY-MM-DD] [turn ...]`)
    ├── fix-tio-deliveries.ts (one-off, 2026-08-18; writes the Senin–Jumat lunch run Tio Jason confirmed on 18 Agustus that the bot acknowledged and never booked — `record_daily_order` took one date per call and the webhook ran only the last tool block. Dry run by default, `--apply` to write; skips dates already on the sheet, refuses to overdraft, and skips 25 Agustus (Maulid Nabi). Kept as the worked example of repairing a lost multi-day run. Run: `set -a && . ./.env.local && set +a && npx tsx scripts/fix-tio-deliveries.ts [--apply]`)
    ├── probe-template-window.ts (re-runnable diagnostic; picks a customer silent for over 30 days — so the 24h window is definitely shut — sends them a real template, waits for the status webhook to land on a throwaway `conversations` row, prints Meta's `errors[]`, then deletes the row. Answers "can we send business-initiated messages at all right now?" in about 30 seconds. Found `131042` / no payment method on 2026-08-18. `hello_world` is not usable — Meta restricts it to test numbers (`131058`) — so it defaults to `delivery_proof` and reuses a real proof photo for the image header. Run: `set -a && . ./.env.local && set +a && npx tsx scripts/probe-template-window.ts [template] [phone]`)
    ├── rescue-payment-proof.ts (re-runnable repair; banks a payment-proof image the webhook saved as a plain `[Image]` — what happened on a parked or taken-over thread before those branches captured proofs. Copies the bytes from `media_id` into the `payment-proofs` bucket, points the newest `pending_payment` order's `payment_proof_url` at them, moves it to `payment_proof_received` so Pending verification shows it, and relabels the conversation row. Dry run by default. Run: `set -a && . ./.env.local && set +a && npx tsx scripts/rescue-payment-proof.ts +62... [--apply]`)
    ├── watch-thread.ts (re-runnable; dumps one customer's live thread by phone — the customer row, their `customer_flags`, every message with role and delivery status, then their orders and `daily_deliveries`. The one command that answers "what did the bot actually do for this person?" while a conversation is still open. Run: `set -a && . ./.env.local && set +a && npx tsx scripts/watch-thread.ts +62...`)
    ├── wait-for-order.ts (re-runnable watcher; polls a thread every 40s, printing each new message, and exits the moment an `orders` row appears for that customer. Meant to run as a background task while a live order is in progress so the bot's failure to create the order is noticed in minutes, not the next morning. Run: `set -a && . ./.env.local && set +a && npx tsx scripts/wait-for-order.ts +62... [minutes]`)
    ├── manual-send.ts (re-runnable; hand-sends one WhatsApp message when the bot has stalled — checks the 24h window first and prints how many hours are left, then `sendTextMessage` + saves to `conversations` as `model_used: "human"` so the inbox shows it. Dry run by default, `--apply` to send. Run: `set -a && . ./.env.local && set +a && npx tsx scripts/manual-send.ts +62... "pesan" [--apply]`)
    ├── create-order-manual.ts (re-runnable; creates an order the bot failed to create, through `createOrderFromExtraction` — the same helper the webhook uses — so pricing, the `daily_deliveries` rows, the customer record and the payment-details message all follow the normal path. Takes an `ExtractedOrderInput` JSON file; `delivery_schedule` is what writes the delivery rows, so list every date with the holidays already removed. Dry run prints the priced package and row count; `--apply` writes, `--no-payment` suppresses the payment message. Run: `set -a && . ./.env.local && set +a && npx tsx scripts/create-order-manual.ts +62... ./order.json [--apply] [--no-payment]`)
    └── upload-welcome-assets.ts (one-off: uploads price list + Dapur 2 menu images to Supabase storage and saves the URLs to settings)
```

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

Any fire-and-forget Claude call in a route under test must be mocked, not just ignored. `analyzeCustomerMessage` is unawaited but goes through the same `getAnthropicClient` mock the webhook tests count calls on, so leaving it real stole responses off the `mockResolvedValueOnce` queue, inflated every `toHaveBeenCalledTimes` by one, and — because it is unawaited — failed on different lines in isolation than in the full suite. `test/webhook.test.ts` mocks it at module level.

Pre-push hook (`.git/hooks/pre-push`): `pnpm lint && pnpm typecheck && pnpm test` — blocks on any failure.

When adding new API routes or webhook code paths, add a corresponding test in `test/`.

## Testing & deployment notes

- Local dev: Supabase CLI local stack (`pnpm supabase start`) OR a dedicated staging Supabase project
- Production deployment: Railway via GitHub auto-deploy on push to `main`
- Environment variables required (see `.env.example`)
- Webhook URL after deploy: `https://[railway-app].up.railway.app/api/webhook/whatsapp`
- Scheduled jobs run **inside the app**, from `src/lib/cron/scheduler.ts`, started by `register()` in `src/instrumentation.ts` when the server boots. Schedules are written in Asia/Jakarta wall-clock time, not UTC. The scheduler is off unless `CRON_IN_APP=true`, because local dev points at the production database and a laptop running `next dev` would otherwise send real customers real WhatsApp messages
- To add a job: append to the `JOBS` table with its `cron` expression and a dynamic import of the route's handler. The routes still exist and still check `CRON_SECRET`, so any job can also be triggered by hand with curl; the scheduler goes through the same check rather than around it. Set `catchUp: true` only if the job runs daily or less often, and only if running it late still does the right thing
- This replaced ten Railway "cron" services (containers whose only job was to curl one route). Every one of them was broken from the day it was created — the container ran bare `curl` with no arguments, printed usage text and exited, so nothing ever reached the app. Quota was never deducted and no reminder was ever sent, for months, because nothing watches the logs of a container that is supposed to be boring. That failure mode is the reason the schedules moved in-process: no container to boot, no secret in a start command, no network hop, and failures land in the app's own logs
- A missed firing is handled differently depending on how often the job runs. The hourly jobs need nothing: each selects on a flag it stamps itself (`abandoned_recovery_sent_at`, `reminder_sent_at`, `quota_deducted`, or a status it moves off), so rows missed during a restart still match at the next firing — at most one hour of latency and never a duplicate. The daily jobs would wait 24 hours, so they carry `catchUp: true` and are re-run at boot if their time passed while the app was down. `cron_runs` (one row per job, written only on a successful run) is what distinguishes "already ran" from "missed it"
- **Catch-up only runs within the same Asia/Jakarta calendar day as the missed occurrence.** That is correctness, not caution: `deduct-daily-quota` deducts for *tomorrow* and `daily-summary` reports on *yesterday*, both relative to when they run rather than when they were due. Running 21:00's quota job at 08:00 the next morning would deduct the wrong day and leave the right one untouched, so a longer outage is logged and skipped instead. A job with no `cron_runs` row at all is seeded without running, so deploying a new daily job cannot fire it at an arbitrary hour
- Repo created and managed via GitHub CLI
- `next.config.ts` sets `serverActions.allowedOrigins: ["*.up.railway.app", "*.railway.app"]` — required to prevent Railway's reverse proxy from triggering Next.js CSRF rejection
