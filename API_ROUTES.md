# API Routes

Quick reference: which file handles which feature. Extracted from `CLAUDE.md` to keep root context lean — read this file on demand when working on API routes.

### Webhook (WhatsApp chatbot)
- `GET /api/webhook/whatsapp` — Meta webhook verification (hub.challenge handshake)
- `POST /api/webhook/whatsapp` — **Main chatbot entry point.** Dedup via `processed_messages`, rate-limit check, Sonnet 5 conversation, tools: `extract_order` / `record_daily_order` / `escalate_to_human` / `ask_admin_for_help`. Meta `statuses[]` webhooks are also handled here and update the matching `conversations.message_id` row with `whatsapp_status` / `whatsapp_status_updated_at` (`sent`, `delivered`, `read`, `failed`). After each inbound customer message is saved to `conversations`, if Haiku's per-message intent classification returns `ordering` and the customer is not already in a current order lifecycle, `customer_state.state` is bumped to `ordering`. Payment-proof image handling and the "skip rate limit while waiting for proof" rule now key off the latest order status (`pending_payment`) instead of mirrored `customer_state` payment stages. Haiku auto-summarizes durable customer context via `src/lib/claude/learn-context.ts`, replaces the `[AI learned context]` block in `customers.notes`, and feeds the freshly learned notes into the same bot response when available; failures are logged and never block replying. Also handles welcome sequence: resolves `{{dapur_list}}`, `{{delivery_areas}}`, `{{price_20}}`, `{{order_deadline}}` placeholders in `welcome_message` setting from live DB data, then sends menu images from active subcontractor rows. The welcome greeting + price list image + each menu image are also logged to `conversations` as `assistant` rows (`model_used: "system"`, image rows use `message_type: "image"` with the URL as content) so they render in the dashboard inbox. Before a reply is sent, `validateReply()` (`src/lib/claude/validate-reply.ts`, Haiku 4.5) checks it against the same "Current context" fields passed into `buildSystemPrompt` (name, notes, quota, state) and flags unsupported customer-specific claims — general FAQ/pricing/menu claims are never flagged. On rejection the bot regenerates once with a corrective instruction; if that also fails, the customer gets the `reply_validation_fallback` template instead of the raw reply, `customer_flags.pending_bot_response` is set, and admins get a high-priority push. The validator fails open (treats as valid) on any network/parse error so a validator outage never becomes a chatbot outage. Known gap: address and payment status aren't yet structured fields in `buildSystemPrompt`'s context, so the validator can't catch hallucinations on those two fields today.

### Auth
- `POST /api/auth/check-admin` — Check if email exists in `admin_users`. ⚠️ Known issue: no session verification, allows unauthenticated email enumeration.
- `POST /api/auth/signout` — Sign out + redirect to `/login`

### Dashboard
- `GET /api/dashboard/metrics` — All KPI metrics in one call (active orders, revenue, deliveries, etc.)

### Orders
- `GET /api/orders` — List orders, optional `?status=` filter
- `POST /api/orders` — Admin creates a new order; accepts `size` (`"s"` | `"m"`, default `"s"`) and `lunch_address_slot` / `dinner_address_slot` (`1` | `2`, default `1`) — a standing per-meal delivery-address rule (slot 2 = the customer's `address_2`). Persisted on the order; the `generate-deliveries` cron and the scheduled-order delivery rows stamp each `daily_deliveries` row's `address_slot` from the matching meal's slot. A per-day flip on the daily sheet still overrides.
- `PATCH /api/orders` — Requires `{ id, action }`. Actions: `"mark_paid"` (sets status → active, records conversion, posts journal + WhatsApp confirmation, and immediately pre-creates `daily_deliveries` for fixed recurring orders instead of waiting for nightly cron; explicit `end_date` wins, otherwise weekday rows are generated from `start_date` until `package_size` portions are consumed; flexible prefs like `per_day_decision` / `custom_schedule` still skip auto-expansion here. Delivery upserts key on the table's real unique constraint: `delivery_date,customer_id,meal_type`). Payment/subscription truth now lives on `orders.status`; `customer_state` is no longer mirrored here. `"mark_payment_proof_received"` (manual admin transition from `pending_payment` → `payment_proof_received`; used by the Payments page's Awaiting payment tab when proof arrives outside the webhook flow). `"update_size"` (updates `size` column only, never recalculates price); `"update_fields"` (allowlisted operational columns only — `area, delivery_address, maps_link, subcontractor_id, meal_time_preference, end_date, size, lunch_address_slot, dinner_address_slot, portions_lunch, portions_dinner, portions_per_delivery, order_type, start_date`; never touches money/quota/status columns — `package_size`, `portions_remaining`, `price_per_portion`, `total_price`, `paid_at` are server-controlled and shown read-only in the detail slide-over, editable only via `mark_paid` or a future dedicated financial-correction action); `"update_status"` (safe side-effect-free transitions only — `paused`/`completed`/`cancelled_by_admin`, stamps `completed_at`/`cancelled_at`; rejects any other value incl. `active` so money-activation stays on the `mark_paid` path). The Orders table rows are clickable → a detail slide-over (`orders-client.tsx`) showing all order fields read-only, editing the operational set via `update_fields`, a Mark-Paid button (pending orders → `mark_paid`), and a status dropdown (→ `update_status`).

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
- Dashboard inbox thread list supports three client-side filters: `All`, `Unread`, and `Unanswered`. `Unread` means the latest conversation row is a customer (`role: "user"`) message; `Unanswered` means `customer_flags.pending_bot_response = true` or `customer_flags.escalated_to_human = true`. A search box further filters visible threads by customer name, phone number, or last message content, client-side, combined with the tab filter.
- Assistant/inbox outbound rows persist Meta's returned `message_id` and start at `whatsapp_status = "sent"` so the UI can later show `Sent`, `Delivered`, or `Read` from webhook updates.
- Manual text replies, manual image sends, and human takeover all clear `customer_flags.pending_bot_response`, so a thread doesn't stay stuck "awaiting bot reply" after an admin handles it.
- `POST /api/inbox/bot-reply` — Admin provides a concise answer → Haiku polishes it → bot sends polished message to customer → clears `pending_bot_response` flag. Optional `save_as_rule: true` also rephrases the answer into a general instruction and inserts it into `chatbot_instructions` so future customers get it automatically (opt-in checkbox in the inbox UI).
- `GET /api/inbox/delivery-proofs/[...path]` — Auth-gated proxy for proof images stored in Supabase Storage; used by the inbox UI so proof attachments render without exposing the storage bucket directly.
- `POST /api/inbox/learn-context` — Manual fallback for the same learned-context summarizer used by the webhook auto-learn path. Requires admin auth and `{ customer_id }`; writes only the `[AI learned context]` block in `customers.notes`.
- `POST /api/inbox/pipeline-stage` — Admin override for customer-level funnel/lifecycle state only. Updates `customer_state.state` to slim states (`new`, `ordering`, `lapsed`, `churned`; legacy `"browsing"` input is normalized to `new`). Payment/subscription state changes no longer happen here and must go through `orders.status`.
- `POST /api/inbox/replay-latest` — Re-run the latest saved inbound customer text through the normal chatbot flow after a thread is unblocked. Requires auth and `{ customer_id }`. Rejects with `{ ok: true, replayed: false, reason: "thread_blocked" }` while `escalated_to_human` or `pending_bot_response` is still true.
- "Regenerate reply" (inbox thread header → More menu) — for re-running the bot on the latest customer message after a system-prompt change or fix, without waiting for the auto-replay trigger. Since `replay-latest` refuses while the thread is blocked, the button first calls `POST /api/inbox/takeover` with `{ escalated: false }` (clears both `escalated_to_human` and `pending_bot_response`) whenever either flag is set, then calls `replay-latest`. Shows the `reason` inline if the replay still doesn't fire (e.g. `welcome_flow_only`, `latest_not_user`).
- `POST /api/inbox/extract-order` — Admin-triggered manual order extraction, for when the bot got stuck (rate-limited, escalated, errored) before ever calling its own `extract_order` tool — common when a customer already typed their full order into chat but the bot never reached the confirmation step. Re-runs Sonnet against a deeper slice of the customer's saved conversation history (60 messages, not just the most recent 20) with `tool_choice` forced onto the `extract_order` schema, trims any trailing assistant messages first because Anthropic forced tool-use requires the conversation to end on a user turn, and also includes any saved `[AI learned context]` notes in the system prompt so the model can still recover fields like area or clarified dates after later back-and-forth. Returns the parsed fields plus server-computed `price_per_portion` and `total_price` for the review modal, without writing to the DB. Shares its DB-write logic (`createOrderFromExtraction` in `src/lib/claude/extract-order.ts`) with the bot's own live `extract_order` tool handler in the webhook route, so the two paths can't drift apart. The live bot's automatic extraction during a real conversation is unaffected — this is purely an additional manual escape hatch. The forced Anthropic tool-use call is wrapped in try/catch (logs and returns `null` → 422 "Could not extract order details from this conversation") so an Anthropic API error surfaces as a real JSON error instead of an unhandled exception that the client can't parse.
- `POST /api/inbox/extract-order/pricing` — Authenticated admin helper used by the inbox review modal when `package_size` is manually corrected after extraction. Returns server-computed `price_per_portion` and `total_price` for the supplied `package_size`; confirm/create still recomputes pricing server-side and does not trust client money fields.
- `POST /api/inbox/extract-order/confirm` — Admin confirms the (optionally edited) parsed fields from the review modal. Accepts optional `send_payment_info` (default `true`): when `true`, creates the order (`pending_payment`) and sends the payment-details WhatsApp message; when `false`, creates the order only and skips the outbound payment message. The live bot path still uses the same shared helper with the default send behavior.
- "Extract order" (inbox thread header → More menu) — opens a review modal (name, address, maps link, area, package size, portions/delivery, start/end date) pre-filled from the extraction call; admin edits anything wrong, then confirms to create the order.

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
- `POST /api/assistant/execute` — Execute a confirmed write-tool action. Body: `{ tool, input, conversationId? }`. Accepts tools in `WRITE_TOOLS` plus `tool: "batch"` for multiple confirmed WhatsApp sends. `mark_order_paid` side effects: sets status → active, conversion tracking, journal entry (Dr Bank BCA / Cr Uang Muka), immediate fixed-recurring `daily_deliveries` pre-generation (same rules as `PATCH /api/orders mark_paid`), WhatsApp confirmation to customer. Payment/subscription truth now stays on `orders.status` and is not mirrored into `customer_state`. `send_whatsapp_message` sends text via WhatsApp, then looks up the customer by `phone_number` and logs the message to `conversations` as an `assistant` row (`model_used: "human"`) so it appears in the dashboard inbox. `send_whatsapp_image` downloads the public image URL, uploads the binary to Meta with `uploadMediaToMeta`, sends by `sendImageMessageById` (not by `image.link`, which can fail silently), then logs the public URL to `conversations` as an `assistant` image row (`message_type: "image"`, `model_used: "human"`). `update_customer_field` allowlist: name, address, area, notes. Confirmation reply persisted to the thread when `conversationId` is provided. Requires auth.
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
