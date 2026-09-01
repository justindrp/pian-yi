# Database Tables

26 tables and 1 view in the `public` schema.

## Migrations apply themselves on push to main

The Supabase project's GitHub integration is on: production branch `main` is wired
to git branch `main` (`supabase branches list --experimental`). **Every push to
`main` runs the pending migrations against production**, without anyone typing
`supabase db push`. The push, not the migration command, is the deploy.

Two consequences, both learned the hard way on migrations 074/075:

- A migration lands **before** Railway finishes building the code that goes with
  it. The gap is the length of a build — a couple of minutes — and during it the
  *old* code is running against the *new* schema.
- Therefore a change that needs a migration and a code deploy in a fixed order is
  **two pushes, not two migrations in one push**. 074 (drop the `NOT NULL`) and
  075 (drop the column) were written as a two-phase rollout and then committed
  together, so 075 applied at push time while the old code — which still wrote
  `orders.portions_remaining` — was live for another two minutes. Nothing broke
  only because no order was inserted in that window; the plan was correct and the
  push undid it.

`supabase db push` by hand is still useful for applying a migration *ahead* of a
push, which is how 074 went out on its own. Run `supabase migration list --linked`
to see what production actually has.

---

## accounts

Chart of accounts for double-entry bookkeeping. Key accounts: 1001–1004 (Cash/Banks), **1005 E-Wallet ShopeePay**, **1006 Bank BCA Valas (USD)**, 1200 Subcontractor Advance, **1201 Courier Cash Advance (Kasbon Kurir)**, 2001 Accounts Payable, **2002 Owner Current Account**, 2100 Unearned Revenue, 2101 Unearned Delivery Fee, 4001 Catering Revenue, **4900 Other Income**, 5001 Subcontractor Cost, **5002 Courier & Delivery Cost**.

**The five accounts added by migration 091 exist because a third of the bank statements had nothing to land in.** Reconciling July and August 2026 on 2026-09-01 found Rp 26,9jt moving through ShopeePay, Rp 3,8jt into the USD pocket and Rp 12,9jt of loans Justin took out personally, none of which the chart could name. 5002 sits in Cost of Services beside 5001, not in Operating Expenses: getting the food to the customer is part of delivering the service. **2002 Owner Current Account is the one to understand** — BCA 4971805760 is Justin's personal account and the business banks in it, so every personal line books to 2002 rather than being filtered away. A Flazz top-up is a drawing, his salary landing there is money lent to the business, and the account balance is the running net either way. There is deliberately **no Loan Payable account**: a loan Justin takes out in his own name and puts in is owed by him to the lender and by the business to him, so it is a 2002 credit. Booking it to a loan account would put a debt on the balance sheet that the business is not party to.

**2100 holds food, 2101 holds ongkir, and the difference is that ongkir is never ours.** Revenue recognition (`PUT /api/deliveries/daily-sheet`) draws 2100 down by `portions × price_per_portion` and nothing else, so a delivery surcharge credited there has nothing that will ever debit it — it becomes a liability the books carry for good. A surcharge is collected from the customer and owed to the kitchen at the same Rp 10.000 a drop, so it is held in 2101 at payment and moved to 2001 Accounts Payable one delivery day at a time, as the drops actually happen; it never touches 4001 or 5001, because a zero-margin pass-through belongs on neither side of the P&L. Sharleen's Rp 220.000 was posted to 2100 on 2026-08-31 and corrected the same day (JV-2026-634, JV-2026-635).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| code | text | Account code (e.g. "1100") |
| name | text | Account name (e.g. "Cash") |
| type | text | Asset, liability, equity, revenue, or expense |
| category | text | Sub-category within type |
| normal_balance | text | "debit" or "credit" |
| is_active | boolean | Whether account is in use |
| created_at | timestamp | |

---

## admin_users

People who can log in to the dashboard. Email is the primary key (matches Supabase Auth). **There is no `id` column** — anything writing to `edit_log` about a row here passes the email as `entity_id`, and an insert that omits `name` fails on the not-null constraint.

| Column | Type | Notes |
|--------|------|-------|
| email | text | Primary key — must match a Supabase Auth account. One person may hold more than one row: Justin signs in as two addresses and needs a row for each, because push filters on this column |
| name | text | Display name. Not null |
| role | text | `"owner"` or `"admin"` — owners have full access, admins are blocked from Accounting |
| created_at | timestamp | |

**A missing row is not a locked door.** `getSessionWithRole()` returns `data?.role ?? "admin"`, so any address with a live Supabase Auth identity gets in with the `admin` role whether or not it appears here. Deleting a row removes push and the owner-only pages; revoking access means deleting the Auth identity as well. See "User roles" in `ADMIN.md`.

---

## area_neighborhoods

Named neighborhoods within each delivery area, used by `/api/settings/neighborhoods` for area-picker autocomplete. RLS enabled (authenticated-only policy, migration 053); only accessed server-side via the admin client.

This table is global and include-only: a row says "this cluster belongs to that area", never that anyone will deliver to it. **Which kitchen will go there, and for how much, lives in `subcontractor_neighborhoods`** — see below.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| area | text | Delivery area. Must be one of the areas some *active* subcontractor serves — there is no fixed list, and the count changes when a kitchen is activated or deactivated. See "Delivery areas" in `OPERATIONS.md` |
| name | text | Neighborhood name, unique per (area, name) |
| created_at | timestamp | |

---

## assistant_conversations

A dashboard Admin Assistant chat thread. Shared across all admins (not per-user). This is separate from customer WhatsApp chat history in `conversations`.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| title | text | Auto-set from first user message (truncated ~40 chars); editable via PATCH |
| created_at | timestamptz | |
| updated_at | timestamptz | Bumped on every persisted turn |

## assistant_messages

One row per message in an Admin Assistant thread (user or assistant). Confirmed assistant actions that send WhatsApp messages are also logged to the customer-facing `conversations` table when they should appear in the Inbox.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| conversation_id | uuid | FK → assistant_conversations (cascade delete) |
| role | text | `"user"` or `"assistant"` |
| content | text | Message text |
| created_at | timestamptz | Ordering within a thread |

## assistant_daily_briefs

One row per day on which the Admin Assistant's automatic morning briefing has already been sent. The date primary key *is* the whole mechanism: the first device to open the assistant inserts the row and wins, every later device gets `23505` and stays quiet.

The guard used to be `localStorage`, which is per-browser — opening the assistant on a phone and then on a laptop ran two independent "once per day" checks and produced the briefing twice. Global, not per-admin, matching `assistant_conversations` (which is itself shared across admins).

`brief_date` must be computed in **Jakarta** time, never UTC: a UTC date rolls over at 07:00 WIB and would hand out a second briefing mid-morning.

| Column | Type | Notes |
|--------|------|-------|
| brief_date | date | Primary key — the Jakarta date the briefing was claimed for |
| claimed_at | timestamptz | Default `now()`; when the claim landed |

---

---

## bank_statements

One bank e-statement, screenshot batch, or hand-typed period. Added by migration 091 on 2026-09-01, after a by-hand reconciliation of July and August found the ledger and the bank describing two different businesses: Rp 17.267.000 was paid to kitchens over the two months and 2001 was never once debited, Agnes's Superbank float moved Rp 16,3jt with 1003 empty, and every Facebook charge, kasbon and admin fee sat outside the books. None of it was discoverable from inside the app, because the app had never seen a statement.

Balances are stored to the sen, not rounded to whole rupiah like the rest of the system, because a statement's whole purpose is the control totals it closes on and rounding breaks them.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| account_code | text | FK `accounts.code` — which ledger account this is evidence for (1002, 1003, 1006) |
| account_number | text | As the bank prints it |
| account_label | text | Account holder name |
| currency | text | Default 'IDR'. A BCA PDF holds an IDR section **and** a separate USD "Poket Valas" section; they are two statements in one file and reconcile independently |
| period_start / period_end | date | |
| opening_balance / closing_balance | numeric(14,2) | |
| total_credit / total_debit | numeric(14,2) | Parsed, and checked against the statement's own printed totals before anything is stored |
| credit_count / debit_count | int | |
| source | text | `estatement` \| `screenshot` \| `manual`. Only an e-statement carries control totals |
| file_path / file_type | text | |
| uploaded_by | text | |
| notes | text | |
| created_at / updated_at | timestamptz | |

Unique on `(account_number, currency, period_start, period_end)` **where `source = 'estatement'`** — a bank issues one statement per account per period, but several partial screenshots of one month is the normal case.

---

## bank_transactions

Every line of a statement, stored whether or not we know what it is.

**`contra_account_code` is the whole design.** A bank line has two sides and one of them is already known — it is the statement's own `account_code` — so the only open question about any line is which account the other side faces. A kitchen payment is 2001, a customer transfer in is 2100, a Flazz top-up is 2002. This was first written as a closed `category` enum (`customer_payment`, `kitchen`, `courier`, …) and that is a second chart of accounts standing beside the real one: every bucket needs a mapping to an account anyway, the two lists drift, and a bucket with no account is a line that can never be journalised. Null means nobody has decided yet, which is the honest state for an unrecognised debit and is exactly what the reconcile queue lists.

`matched_by` being set is what tells a re-import that a human decided this line, so a parser fix re-run does not overwrite the correction with its own guess.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| statement_id | uuid | FK `bank_statements.id`, ON DELETE CASCADE |
| row_index | int | Position in the statement. Unique with `statement_id`, so a re-parse overwrites rather than duplicates and two identical lines on one day stay distinguishable |
| txn_date | date | |
| txn_time | text | Superbank prints a clock time, BCA does not |
| direction | text | `CR` \| `DB` |
| amount | numeric(14,2) | |
| balance_after | numeric(14,2) | |
| counterparty | text | As the bank spells it, which is not how the customer spells it |
| description | text | |
| raw_text | text | The matched block, for when a parse looks wrong |
| contra_account_code | text | FK `accounts.code`, nullable — see above |
| journal_id | uuid | FK `journals.id` ON DELETE SET NULL. Null means the money moved and the books do not know it |
| matched_at / matched_by | timestamptz / text | |
| notes | text | |
| created_at | timestamptz | |

Import with `pnpm tsx --env-file=.env.local scripts/import-bank-statements.ts <file.pdf>`. The parser (`src/lib/accounting/statement-parser.ts`) refuses to store a statement whose control totals do not tie — a half-parsed statement reconciles against nothing while looking like it did. That guard earned itself immediately: the Superbank row regex required a newline between the description and the amount, and the extractor emits both forms in the same file, so 18 of 49 July rows were being dropped silently.

---

## broadcast_recipients

One row per customer per broadcast — tracks delivery status for each recipient.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| broadcast_id | uuid | FK → broadcasts |
| customer_id | uuid | FK → customers |
| phone_number | text | Recipient's phone at send time |
| personalized_message | text | Final message text sent to this customer |
| status | text | "pending", "sent", "failed" |
| sent_at | timestamp | When the message was sent |
| error | text | Error message if failed |

---

## broadcasts

A bulk WhatsApp send campaign, targeting a filtered subset of customers.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| instruction | text | Natural-language instruction an admin typed (e.g. "remind active customers about weekend menu") |
| message_template | text | Personalized message template Haiku generated |
| filter | json | Criteria used to select recipients |
| recipient_count | integer | How many customers were targeted |
| status | text | "draft", "sent" |
| created_by | text | Admin email who triggered it |
| created_at | timestamp | |

---

## chatbot_instructions

Custom instructions an admin adds via the Chatbot Training page. Active ones are appended to the system prompt at runtime.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| instruction | text | The instruction text injected into the system prompt |
| description | text | Human-readable label for the instruction |
| is_active | boolean | Only active instructions are injected |
| created_by | text | Admin email who wrote it |
| created_at | timestamp | |
| updated_at | timestamp | |

---

## cron_runs

When each scheduled job last completed successfully — one row per job, not a run history. Written by the in-app scheduler (`src/lib/cron/scheduler.ts`) through the service-role client; nothing in the dashboard reads it.

Its only purpose is to let the scheduler tell "already ran today" from "missed it while the app was restarting", which is what the boot-time catch-up for daily jobs turns on. Only successful runs are recorded, so a failed job still looks missed and is retried. A job with no row is seeded without running.

| Column | Type | Notes |
|--------|------|-------|
| job_name | text | Primary key — matches `name` in the scheduler's `JOBS` table |
| last_run_at | timestamptz | Set on successful completion only |

## conversations

Full chat history between customers and the bot. Rows are inserted once; only WhatsApp delivery metadata (`message_id`, `whatsapp_status`, `whatsapp_status_updated_at`, `whatsapp_error`) may be backfilled or advanced later when an outbound send completes or Meta posts a receipt webhook.

Inbox thread ordering and the `Unread` filter both derive from the latest `conversations` row per customer. A thread is considered unread in the dashboard when that latest row has `role = "user"`.

That "latest row per customer" is served by the `inbox_threads` view (see below), not by fetching a window of recent messages.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| customer_id | uuid | FK → customers |
| role | text | "user" or "assistant" |
| content | text | Message text. For image **and document** rows this is the **caption**, with the file URL in `media_url`. Rows written before 2026-08-21 (and the menu/price-list sends) hold the URL here instead, which is why the Inbox falls back to it — storing the URL as content dropped the caption from both the Inbox and the model's history, so a late-delivery apology sent to a customer appeared nowhere in the dashboard. Document rows stored the URL as content until 2026-08-31 for the same reason and with the same result: three invoices went out on 30–31 Agustus, each captioned with a summary of what was being charged, and the inbox drew only the file |
| message_id | text | WhatsApp message ID. Inbound rows save this immediately; outbound rows backfill it after Meta accepts the send so status webhooks can match the row |
| message_type | text | "text", "image" or "document" |
| media_id | text | WhatsApp media ID for inbound media; used by `/api/inbox/media/[mediaId]` proxy. Outbound/manual image rows usually keep this null and store the public URL in `content`. Not durable on its own — Meta deletes inbound media after about a week, so `media_url` is the reference that survives |
| media_url | text | Supabase Storage URL in the private `chat-media` bucket, written by the webhook at receipt time (migration 060) and served through `/api/inbox/chat-media/[...path]`. NULL for rows saved before that, and for rows rescued by `scripts/backfill-chat-media.ts`, which wrote the URL into `content` instead. Kept separate from `content` so captions and `[Dokumen: name]` labels — which the bot reads back as conversation context — are not overwritten |
| intent | text | Haiku classification (e.g. "ordering", "inquiry") |
| model_used | text | Who wrote the message. `role:model` for anything a model wrote (`sonnet:deepseek-v4-flash`, `haiku:deepseek-v4-flash`) — both halves, because the "sonnet" and "haiku" roles point at the same model in production, so neither one alone identifies the row. Written by `modelTag()`, classified by `modelRole()` (`src/lib/claude/model-tag.ts`), which also matches the legacy bare values (`sonnet-4-6`, `sonnet-5`, `haiku-4-5`) so old rows keep counting on `/reports`. `"human"` for manual/admin-assistant sends, `"system"` for automated welcome/menu rows |
| input_tokens | integer | Tokens consumed on input (assistant turns) |
| output_tokens | integer | Tokens produced on output (assistant turns) |
| whatsapp_status | text | Latest outbound WhatsApp receipt state for assistant rows: "sent", "delivered", "read", or "failed" |
| whatsapp_status_updated_at | timestamptz | When `whatsapp_status` last changed |
| whatsapp_error | jsonb | Meta's `errors[]` from a failed status webhook (`[{code, title, message}]`), null otherwise. Migration 069 — before it the code only reached `console.error`, so two months of failed delivery proofs could not be diagnosed after log rotation |
| sent_by | text | Email of the admin who composed this outbound message. Migration 071. NULL for bot replies, system rows, inbound messages, and everything written before 2026-08-21 — `model_used = "human"` said a human typed it but never which one, so every hand-typed reply was anonymous. Set by the inbox manual reply/image/document routes, the Assistant's send tools, and the admin-confirmed bot reply; `scripts/manual-send.ts` writes `script:manual-send` |
| created_at | timestamp | |

---

## customer_flags

One row per customer. Holds boolean flags and escalation state. Users cannot edit this table directly.

The dashboard Inbox `Unanswered` filter is derived from this table: a thread is considered unanswered when either `pending_bot_response` or `escalated_to_human` is true.

| Column | Type | Notes |
|--------|------|-------|
| customer_id | uuid | Primary key, FK → customers |
| escalated_to_human | boolean | True when an admin needs to take over the conversation |
| escalation_reason | text | Why it was escalated |
| last_human_activity_at | timestamptz | Stamped on takeover and each manual reply (including `scripts/manual-send.ts`); bot auto-resumes after 30 min of admin inactivity (`TAKEOVER_INACTIVITY_MINUTES`). NULL means never auto-resume |
| hold_until | timestamptz | Migration 090. While in the future, neither resume path hands the thread back however quiet the admin has been. NULL = the ordinary 30-minute rule, which is what every pre-090 row has. Always finite — set from a short menu (30 min / 2 jam / 24 jam) and cleared on resume |
| pending_bot_response | boolean | True when bot is waiting for an admin's answer via Inbox |
| pending_bot_question | text | The question the bot needs an admin to answer |
| is_blacklisted | boolean | Bot ignores all messages from blacklisted customers |
| is_suspicious | boolean | Flagged by injection detection |
| needs_human_review | boolean | General review flag |
| vip_status | boolean | VIP customers |
| created_at | timestamp | |

---

## customer_rate_limits

One row per customer. Tracks message and token usage for rate limiting. Users cannot edit this table directly.

| Column | Type | Notes |
|--------|------|-------|
| customer_id | uuid | Primary key, FK → customers |
| daily_message_count | integer | Bot replies sent today |
| minute_message_count | integer | Bot replies sent in the last minute |
| daily_token_count | integer | Tokens used today |
| last_message_at | timestamp | When the last message was processed |
| last_reset_at | timestamp | When daily counters were last reset |

---

## customer_state

One row per customer. Tracks customer-level funnel / lifecycle state only, not per-order payment status.

| Column | Type | Notes |
|--------|------|-------|
| customer_id | uuid | Primary key, FK → customers |
| state | text | Current state: "new", "ordering", "lapsed", or "churned". Legacy rows may still contain older values until backfilled. |
| menu_shown | boolean | Whether the welcome sequence (menu images) has been sent |
| reactivation_count | integer | How many times a re-engagement message has been sent |
| reactivation_sent_at | timestamp | When the last re-engagement message was sent |
| updated_at | timestamp | |

---

## customers

Every person who has messaged the business on WhatsApp. Phone number is the primary identifier.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| customer_number | integer | Short human-friendly customer number |
| phone_number | text | WhatsApp number in international format (+628...). Unique — partial index `customers_phone_number_unique` (migration 065) excluding `IMPORT_%` slugs. Always write the canonical `+62` form; before migration 065 the same person could exist twice as `+628...` and `628...` |
| name | text | Full name (filled in when they place an order) |
| address | text | Delivery address |
| area | text | Delivery zone. The permitted values are the union of the active subcontractors' `delivery_areas`, read at request time — every dropdown that offers this field now derives its options from `/api/areas` |
| sub_area | text | Sub-location within the area: district name for houses, apartment name for apartments, building name for offices |
| address_type | text | "house", "apartment", or "office" — classified by Sonnet at order time |
| google_maps_link | text | Google Maps URL for the delivery address |
| delivery_phone | text | Alternative phone number for delivery if different |
| meal_time_preference | text | Display-only. Null for 381 of 384 customers, read by no decision path, rendered in one panel of the chatbot-training screen. The order-level column of the same name was dropped in migration 077 and the code that expanded these values into dates was deleted on 2026-08-28. Do not wire anything new to it. |
| custom_schedule | json | Per-weekday schedule if preference is "custom_schedule" |
| subcontractor_id | uuid | FK → subcontractors — which kitchen serves this customer |
| portions_remaining | integer | Dead column — never read it. See the `customers.portions_remaining` rule in `CLAUDE.md`. `orders.portions_remaining` was the same idea one table over and was dropped in migration 075; this one survives only because 27 customers hold a cached balance with no order behind it. Was meant as the total quota balance across all active orders |
| avg_price_per_portion | integer | Weighted average cost per portion across all active orders (WAC method) |
| delivery_route | smallint | Route number (1 = Alam Sutera/BSD Lama, 2 = Gading Serpong/BSD Baru) |
| delivery_position | integer | Zero-based sort order within the route for the daily delivery sheet |
| address_2 | text | Second delivery address |
| area_2 | text | Delivery zone for the second address |
| sub_area_2 | text | Sub-location for the second address |
| google_maps_link_2 | text | Google Maps URL for the second address |
| ad_creative | text | Meta Ads creative code that drove first contact (e.g. "C4") — auto-detected from first WhatsApp message |
| first_message | text | First message the customer sent |
| converted_at | timestamptz | When the customer's first order was marked paid |
| package | text | Package description from first order |
| total_portions | integer | Total portions purchased across conversion orders |
| total_payment | integer | Total amount paid in IDR across conversion orders |
| promo_used | text | Promo code or campaign description (manual) |
| converted_to_subscription | boolean | Whether customer converted to a recurring subscription (default false) |
| notes | text | Internal notes about this customer, plus the `[AI learned context]` block `learnCustomerContext()` rewrites wholesale. Dashboard and chatbot only — **the kitchen never reads this column** |
| kitchen_notes | text | What the cook must do differently, in the customer's own terms ("tanpa nasi", "tidak ada kacang"). The only customer text printed on the unauthenticated `/dapur/[id]` sheet. Written by an admin (Customers → Catatan dapur) or by `extract_order`'s `catatan` via `mergeKitchenNote()`; **never by the summarizer** — it used to reach the sheet through the `Preferensi:` bullet in `notes` and cooked Carolin six portions without rice on 2026-09-01 off a restriction she had never given (migration 089) |
| linked_order_id | uuid | FK → orders, nullable. If set, this customer's daily draws come from someone else's order/quota instead of their own (e.g. a kid drawing from a parent's package) |
| contract_price_per_portion | integer | Negotiated per-portion rate for a corporate customer, in IDR. When set it replaces the `pricing_tiers` lookup entirely and lifts the 5/6 divisibility rule — a company buys box counts, not packages. Read via `contractPrice()` by pricing, payment-size matching and the system prompt. NULL = ordinary tier pricing, which is every customer but PT Bintang Lautan |
| created_at | timestamp | |
| updated_at | timestamp | |

---

## daily_deliveries

One row per delivery event. Created when a customer requests a delivery for a specific day.

**The row is the state.** Present means this food will be cooked and delivered; absent means it will not. There is no `status` column — it was dropped in migration 075 after holding `'scheduled'` on all 2937 rows it ever had, while seven read paths each carved out values nothing ever wrote. A skip is a `DELETE` through `deleteDelivery()` (`src/lib/orders/delivery-state.ts`), which copies the row into `edit_log` first; deleting it is also what returns the portion, since every balance is `package_size` minus the rows that exist. Delivered-vs-scheduled is derived from the date (`date <= today`), and whether the booking is still cancellable from `isLocked()` (D-1 16:00 WIB).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| order_id | uuid | FK → orders |
| customer_id | uuid | FK → customers |
| subcontractor_id | uuid | FK → subcontractors — which kitchen fulfills this delivery |
| delivery_date | date | Date of delivery (YYYY-MM-DD) |
| meal_type | text | "lunch", "dinner", "both", or "breakfast". No CHECK constraint — the value is free text, and `UNIQUE (delivery_date, customer_id, meal_type)` is what limits a customer to one row per slot per day. "breakfast" exists for event bookings with a morning run (ICE BSD, 21–23 Agustus 2026); no standing package produces one. Anything reading this column must handle it — `/dapur/[id]` filtered on lunch/dinner only and rendered the morning rows nowhere |
| portions | integer | Number of portions for this delivery |
| address_slot | smallint | Which customer address to deliver to: 1 = primary, 2 = secondary (default 1) |
| notes | text | Special instructions |
| delivery_proof_id | uuid | FK → delivery_proofs — photo proof from subcontractor |
| feedback_message | text | Customer's post-delivery feedback text |
| feedback_sentiment | text | Haiku sentiment classification of feedback |
| created_at | timestamp | |
| updated_at | timestamp | |

---

## delivery_proofs

Photos sent by subcontractors via WhatsApp as proof of delivery. Haiku matches each photo to a daily delivery.
Admins can also upload a proof directly from each row in the Deliveries sheet; the mobile table reserves a dedicated action column so the camera uploader stays fully visible on narrow screens.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| subcontractor_id | uuid | FK → subcontractors — who sent the photo |
| sender_phone | text | Phone number the photo came from |
| whatsapp_message_id | text | WhatsApp message ID of the photo |
| image_url | text | Public URL of the uploaded photo in Supabase Storage |
| caption | text | Caption attached to the photo |
| status | text | "admin_uploaded" (awaiting send), "auto_sent", "manually_sent", "needs_review", "unmatched" |
| matched_delivery_id | uuid | FK → daily_deliveries — the delivery this photo is matched to |
| matched_customer_id | uuid | FK → customers |
| match_confidence | number | 0–1 confidence score from Haiku |
| match_method | text | How the match was made (e.g. "ai", "manual") |
| sent_by | text | Admin who sent the proof to the customer |
| sent_to_customer_at | timestamp | When the proof was forwarded to the customer |
| received_at | timestamp | Stamped to the admin-selected delivery date on admin upload (GET filters proofs by this date) |

---

## edit_log

Append-only audit trail of all admin changes to key records. Never updated or deleted.

Written through `logEdit()` (`src/lib/audit/log-edit.ts`), which never throws: it is called after the business write has already landed, so failing the request over a missing audit row would 500 an action that actually happened. Failures go to `console.error` instead.

Read by the Activity page (`/activity`) via `GET /api/audit`. Fourteen routes still write their own inline insert rather than calling the helper; both shapes land in the same table.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| entity_type | text | Table that was changed (e.g. "orders", "subcontractors"), or `assistant_tool` for a confirmed Assistant write |
| entity_id | text | ID of the record that was changed. For `assistant_tool`, the order/customer/phone the tool targeted, falling back to the tool name |
| action | text | "create", "update", "delete", or the specific operation — `mark_paid`, `reject_payment_proof`, `update_status`, `bulk_create`, an Assistant tool name |
| changed_by | text | Admin email, or `system:<job>` for a machine write |
| changes | json | The fields written, or enough of them to say what happened |
| created_at | timestamp | |

Coverage as of 2026-08-21: orders (create/update/status/size/mark_paid/reject/delete), customers (create/update/delete), delivery_proofs (send/unmatch/delete), daily_deliveries (bulk_create, daily-sheet save/delete), subcontractors and their off-days, chatbot_instructions, area_neighborhoods, accounting journals and accounts, settings, pricing, templates, admin_users, broadcasts, free-quota grants. Not logged: `PATCH /api/customers/reorder` (display ordering, and a drag would write one row per customer moved), the read-only and chat routes, and the crons.

**Three dashboard screens used to write straight to Postgres from the browser** with the user-scoped client, which meant no route ran and nothing recorded the actor: the Customers edit form and its inline cells, the bot kill switch, and the Payments "reject proof" button. All three now go through their API route. Adding a new dashboard write means adding a route, not a `supabase.from(...).update()` in a client component.

---

## invoice_sequences

Last used sequence number per calendar month, for `next_invoice_number()`. Mirrors `journal_sequences`.

| Column | Type | Notes |
|--------|------|-------|
| period | text | Primary key, `YYYY-MM` |
| last_seq | integer | Last number issued in this month |

`next_invoice_number(p_period text)` does the `insert … on conflict do update … returning` in one statement and returns `INV/PY/2026-09/0001`. Allocation lives in the database on purpose: two concurrent sends reading `last_seq` in Node would collide on the unique constraint on `invoices.number` *after* both PDFs had been rendered.

---

## invoices

One row per order, written by `sendInvoice()` (`src/lib/invoices/send.ts`) — the bot's `send_invoice` tool. Both invoices sent before this table existed were rendered by hand and left no record of the number, the amount, or that they had been sent.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| order_id | uuid | FK → orders, **unique**. One invoice per order; a second package is a second invoice |
| customer_id | uuid | FK → customers. Who is **billed** — the payer (`orders.paid_by_customer_id`) on a package bought for someone else, not the person who eats it |
| number | text | Unique, `INV/PY/YYYY-MM/NNNN`, allocated once and reused on every resend |
| issued_on | date | |
| total | integer | IDR, as printed. Not re-read from `orders.total_price`, which can be edited after the PDF was sent |
| pdf_url | text | The PDF in the `menu-images` bucket. Null only between allocating the number and the upload landing |
| sent_count | integer | |
| last_sent_at | timestamptz | A resend inside ten minutes is refused |
| created_at | timestamptz | |

The number is never re-allocated, but the **PDF is re-rendered on every send**: the paid state on it may have changed since. `orders.paid_at` is the only thing that prints the LUNAS stamp — `payment_proof_received` is a claim, not a receipt.

RLS: service role only. The browser client never touches either table.

---

## journal_lines

Individual debit/credit lines within a journal entry.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| journal_id | uuid | FK → journals |
| account_id | uuid | FK → accounts |
| debit | integer | Debit amount in IDR (0 if this is a credit line) |
| credit | integer | Credit amount in IDR (0 if this is a debit line) |

---

## journal_sequences

Tracks the last used sequence number per year for generating journal reference codes.

| Column | Type | Notes |
|--------|------|-------|
| year | integer | Primary key |
| last_seq | integer | Last sequence number used in this year |

---

## journals

A double-entry journal entry (the header). Each journal has two or more lines in `journal_lines`.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| reference | text | Human-readable reference code (e.g. "JNL-2026-0001") |
| date | date | Transaction date |
| description | text | What this entry records |
| source_type | text | What generated this entry (`order_payment`, `delivery`, `delivery_cogs`, `manual`) |
| source_id | text | ID or composite key of the source record. Auto-generated delivery journals use `rev_{date}_{meal_type}` / `cogs_{date}_{meal_type}` — one aggregated journal per meal per day, idempotent on first save |
| notes | text | Calculation breakdown shown in the UI (e.g. "45 porsi: 20p × Rp19.500, 25p × Rp21.000 = Rp915.000") |
| created_at | timestamp | |

---

## message_templates

Bot message templates editable by admins from the Settings page. Keyed by name.

| Column | Type | Notes |
|--------|------|-------|
| key | text | Primary key — template name (e.g. "chatbot_unavailable", "rate_limit_exceeded") |
| template | text | The message text sent to customers |
| description | text | What this template is used for |
| updated_at | timestamp | |

---

## orders

An order is the main commercial agreement with a customer — either a fixed-schedule or quota-based catering package.

No address/area columns here — `area`, `delivery_address`, `maps_link` were dropped in migration 056 (duplicated `customers.area`/`address`/`google_maps_link` and drifted out of sync). Read delivery address live via join on `customers`.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| customer_id | uuid | FK → customers — **who eats the food**. On a package bought for someone else this is the beneficiary, not the buyer |
| paid_by_customer_id | uuid | Nullable FK → customers (migration 073). Set only when someone other than `customer_id` bought and pays for the package. `cancel-unpaid` and the payment quote go to this person; `/payments` renders them as "Dibayar oleh". Null on an ordinary order. It is a third FK from `orders` to `customers`, so **every embed of `customers` from an `orders`-rooted query needs an explicit hint** — `customers!orders_customer_id_fkey(...)` or `payer:customers!orders_paid_by_customer_id_fkey(...)` — or PostgREST answers `PGRST201`. Adding it broke `send-reminders` and `renewal-reminders`, which had never carried a hint |
| subcontractor_id | uuid | FK → subcontractors — which kitchen fulfills this order |
| status | text | "pending_payment", "payment_proof_received", "active", "paused", "completed", "cancelled_unpaid", "cancelled_by_customer", "cancelled_by_admin", "refunded" |
| package_size | integer | Total portions bought (e.g. 20) |
| portions_per_delivery | integer | Portions per meal per delivery (e.g. 1 or 2) |
| portions_lunch | integer | Portions at lunch (for fixed both_fixed orders) |
| portions_dinner | integer | Portions at dinner (for fixed both_fixed orders) |
| size | text | Portion size: `"s"` (menu items 1, 2, 3, 5) or `"m"` (all five — one extra side dish) — default `"s"`, constraint `IN ('s', 'm')`. Read it through `normalizeSize()` (`src/lib/orders/size.ts`): legacy rows and a model-filled field both reach `null`, and anything that is not the literal `"m"` is S. M adds `settings.size_m_surcharge` to `price_per_portion` at creation and is only sold by a kitchen with `offers_size_m` |
| price_per_portion | integer | Locked-in price in IDR at order time (includes size surcharge if "m") |
| total_price | integer | Total amount due in IDR |
| source | text | "purchase" (default), "free_quota" or "event" (migration 080). free_quota rows are admin-granted goodwill/compensation portions (price_per_portion 0, total_price 0), created via `POST /api/customers/free-quota`. "event" is a one-off catering booking — a real purchase, but not a package anyone renews, so renewal and expiry reporting skips it; Ade Dian's 180 portions across 21–23 Agustus 2026 are the worked example. Both readers of the column test for "free_quota" alone, so an event order still displays as a purchase |
| grant_reason | text | Nullable. Why a free_quota order was granted (e.g. "late delivery compensation") |
| granted_by | text | Nullable. Admin email who granted a free_quota order |
| addon_cost_per_portion | integer | What the kitchen charges us extra per portion for an add-on (e.g. nasi merah, Rp 5.000). Cost side only — the customer's share of it is already inside `price_per_portion`. Added to the subcontractor's route rate by the COGS journal and by the `/dapur/[id]` bill. Edited as "Tambahan / porsi" on the new-order modal and the Orders slide-over; per order, so it does not carry to the customer's next package |
| amount_paid | integer | IDR received against this order so far, default 0. For DP / partial payment on corporate orders; `total_price` stays the contracted amount. Set by an admin in the Orders slide-over ("Sudah dibayar") — nothing derives it and nothing gates on it |
| lunch_address_slot | smallint | Standing address slot for lunch deliveries: 1 = primary, 2 = secondary (customers.address_2) — default 1. Generated daily_deliveries rows inherit it; per-day sheet flip overrides |
| dinner_address_slot | smallint | Standing address slot for dinner deliveries: 1 = primary, 2 = secondary — default 1 |
| requested_schedule | jsonb | Nullable. The days the customer asked for: `[{date, meal_type, portions}]`. Written once at order creation, read once by `mark_paid` to write `daily_deliveries`, never read again — the rows are the truth from there. Null means they bought quota without naming days and book per date — that is what `extract_order`'s `delivery_schedule: []` stores, and it is a normal order, not a gap. `mark_paid` filters the days through `isDeliveryDay()`, so a Minggu or a libur nasional in the list is dropped and its portions stay unbooked. Replaced `meal_time_preference`, dropped in migration 077: a single enum could not express a per-day schedule, and reading a delivery row against it produced a false bug report on correct food. |
| custom_schedule | json | Per-weekday schedule if preference is "custom_schedule" |
| start_date | date | First delivery date |
| end_date | date | Last requested delivery date |
| payment_proof_url | text | URL of payment transfer screenshot |
| payment_proof_received_at | timestamptz | When the proof arrived (migration 079). The Payments page printed `confirmed_at` under a "Proof received" label until 2026-08-30, so Naya's row claimed 24 Agu 12.12 for a proof that came in at 13.33 that day. NULL on every order that reached `payment_proof_received` before the migration; the page says "Order confirmed" for those rather than inventing a time. Backfillable where the proof is still in the thread: the arrival time is the customer's last `conversations` row with `role='user'`, `message_type='image'` and a `payment-proofs` URL **in `content` — not in `media_url`, which is NULL on those rows**, between the order's `confirmed_at` and its `paid_at`. Last, not first: an earlier image may have been a wrong or rejected transfer. Two further guards, because a customer's older proof must not be read as this order's: skip an order with no `confirmed_at` (nothing bounds the search — `created_at` is the import date on the June rows, months after the chat), and skip a timestamp another order already holds. 14 orders were filled that way on 2026-08-30 and logged as `backfill_payment_proof_received_at`, taking the column to 18 of 38 paid orders. The remaining 20 are unrecoverable: 5 have no `confirmed_at` (galvent, Julian S `eb3179b7`, Elaine, Elvia, Tia) and 15 have no proof image in the thread at all — paid by a third party, sent before the image-storage flow, or confirmed by hand. **A shared timestamp is legitimate when one transfer paid for two orders** — Naya's proof carries both her order and Cila's. |
| delivery_surcharge_per_delivery | integer | IDR the kitchen charges extra to reach this address, per drop (migration 085). Copied from `subcontractor_neighborhoods.surcharge_per_delivery` at order creation and locked there, like `price_per_portion` |
| delivery_surcharge_total | integer | `delivery_surcharge_per_delivery` × the number of drops the package pays for, already inside `total_price`. It is the customer's share; nothing on the cost side reads it |
| pause_until | date | If paused, resume from this date |
| cancellation_reason | text | Why it was cancelled |
| reminder_sent_at | timestamp | When the payment reminder was last sent |
| abandoned_recovery_sent_at | timestamp | When the re-engagement message was sent |
| followup_sent_at | timestamp | When the post-delivery satisfaction follow-up was sent |
| confirmed_at | timestamp | When the customer confirmed the order with "YA" |
| paid_at | timestamp | When payment was verified. **Only `mark_paid` writes it, and only `mark_paid` posts the `order_payment` journal** — `POST /api/orders`, the dashboard's own new-order form, writes the delivery rows and even posts revenue and COGS journals for past slots, but neither stamps this column nor books the money. So an admin who types up an order the customer has already paid for (which is what a takeover does) leaves no timestamp and no journal, while the food goes on the sheet: Fahmi `35093d5c`, Vania `11b8b86d`, Nadya `0e20e551` and Febby `19aabe69` were all found that way on 2026-09-01 and backfilled from their threads (actor `system:paid-at-backfill`, the admin's own acknowledgement of the transfer proof, since verified is what this column means). The books are the larger half of it — see the P1 accounting task in `pnpm tasks` |
| completed_at | timestamp | When the order was marked complete |
| cancelled_at | timestamp | When the order was cancelled |
| created_at | timestamp | |
| updated_at | timestamp | |

---

## pricing_tiers

Price per portion at each quantity tier. The `portions` column is the minimum quantity to qualify. Current customer-facing chatbot sales are S-only. Fixed-schedule durations must be multiples of 5 days; multiples of 5 can be priced as repeated 5-day blocks, while non-multiples of 5 should be rejected politely.

| Column | Type | Notes |
|--------|------|-------|
| portions | integer | Primary key — minimum package size to get this price |
| price_per_portion | integer | Price in IDR per portion at this tier |
| updated_at | timestamp | |

Current tiers: 5→29k, 10→28k, 20→27k, 40→26k, 60→26k, 120→25k

---

## processed_messages

Idempotency log for incoming WhatsApp messages. Checked before processing any webhook event. Never deleted.

| Column | Type | Notes |
|--------|------|-------|
| message_id | text | Primary key — WhatsApp message ID |
| received_at | timestamp | When the webhook arrived |
| processed_at | timestamp | When processing completed (null if still in-flight) |
| error | text | Error message if processing failed |

---

## webhook_events

Raw WhatsApp webhook payloads, written **before** the route returns 200 to Meta (migration 067). Distinct from `processed_messages`, which is the idempotency key log: this table holds the actual payload so a delivery that arrived but never finished processing can be found and replayed.

Only inbound messages are landed here. Status receipts (`statuses[]`) are acknowledged immediately — Meta re-sends them constantly, and blocking on a write for them would slow the noisiest half of the traffic to protect nothing.

If the insert fails the webhook returns 503 rather than 200, so Meta retries; `processed_messages` makes the redelivery harmless. That is the whole point of the table — a 200 sent before the payload is durable is a message Meta will never send again.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| event_key | text | Unique — Meta's message id. A retry lands on the existing row. Null when unkeyable (still stored) |
| payload | jsonb | The raw webhook body, as received |
| received_at | timestamp | Default now() |
| processed_at | timestamp | Set when processing finished cleanly; null means queued, in-flight, or failed |
| error | text | Last failure reason, cleared on success |

Find deliveries that arrived and never finished: `select * from webhook_events where processed_at is null` (partial index on `received_at` covers exactly this).

---

## push_subscriptions

Browser push notification subscriptions (Web Push / VAPID) for admin devices.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| user_email | text | Admin email who subscribed. Plain text, **no FK** to `admin_users.email` — nothing keeps it in step when an admin is removed, so `sendPushToAllAdmins` filters every send against the current `admin_users` list (trimmed + lowercased) rather than trusting the row's existence. Orphan rows are left in place; they are inert once filtered |
| endpoint | text | Browser push endpoint URL |
| p256dh | text | Public key for push encryption |
| auth | text | Auth secret for push encryption |
| created_at | timestamp | |
| last_used_at | timestamp | When a notification was last successfully sent to this subscription |

---

## settings

Key-value store for all configurable business settings. Edited via the Settings page.

| Column | Type | Notes |
|--------|------|-------|
| key | text | Primary key — setting name |
| value | text | Setting value (always stored as text) |
| description | text | What this setting controls |
| updated_by | text | Admin email who last changed it |
| updated_at | timestamp | |

Notable keys: `business_name`, `chatbot_enabled`, `welcome_message`, `price_list_image_url`, `bank_name`, `bank_account_number`, `bank_account_name`, `order_deadline_hour`, `order_deadline_daily_hour`, `size_m_surcharge` (rupiah added per portion for size M, on top of the S tier or a contract rate — Rp 4.000; a missing or unparseable value reads 0 and prices M as S), `casual_mode_probability`, `typing_delay_base_seconds`, `escalation_keywords`, `instagram_handle`, `admin_display_name` (the one admin the bot may name to a customer when it hands off — "Kak Justin"; empty means it says "tim admin kami" and names nobody, migration 087), `whatsapp_business_number` (the WABA the app sends through), `whatsapp_manual_number` (the hand-operated second account, migration 081) and `proof_forwarder_phones` (comma-separated numbers allowed to forward a delivery photo to the WABA and have it sent on to the customer named in the caption, migration 083; the manual number was added by 088, which appends rather than overwrites because the list is edited in the UI — see "Proof Relay" in `docs/ADMIN.md`). Of the two numbers, `whatsapp_manual_number` is read by `windowWarning()` in `src/lib/deliveries/forwarded-proof.ts`, which names it to an admin whose forwarded proof went to a closed window, and `whatsapp_business_number` is read by `manualDraft()` in the same file, which puts it in the paste-ready message asking a closed-window customer to chat the main number. The manual one must never be added to `src/lib/claude/prompts/system.ts`, which reads settings by name and would hand customers a channel with none of the API path's guards. See "The manual number" in `docs/WHATSAPP.md`

`welcome_message` supports four template placeholders resolved at send time: `{{dapur_list}}` (active subcontractor names), `{{delivery_areas}}` (unique delivery areas from active subcontractors), `{{price_20}}` (20-portion tier price formatted as e.g. `27RB`), `{{order_deadline}}` (order_deadline_hour formatted as e.g. `16.00`). `price_list_image_url` is sent automatically to new WhatsApp contacts before the AI reply; keep it synced with the current Paket Personal S price list.

---

## subcontractor_neighborhoods

One kitchen's verdict on one neighborhood: will it go, and does it charge extra to go. Added in migration 085. RLS enabled, authenticated-only policy; read server-side through `src/lib/subcontractors/coverage.ts`, written by `PUT /api/subcontractors/coverage` (logged as `subcontractor_neighborhoods`).

**A missing row means "served, normal rate".** Rows exist only for the neighborhoods a kitchen has actually ruled on, which is how coverage worked before this table existed and what an empty table has to keep meaning. `subcontractors.delivery_areas` is still coverage at the area level; this is the exception list underneath it, because a kitchen's own courier knows finer than an area name: Dapur 1 carries BSD Lama and Alam Sutera and still refuses Kost Casa Living, and charges Rp 10.000 a drop for Apartemen Akasa (migrations 085 and 086, both from the same evening — Akasa was seeded as a refusal and re-priced hours later once the kitchen was asked again).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| subcontractor_id | uuid | FK → subcontractors, cascade delete |
| neighborhood_id | uuid | FK → area_neighborhoods, cascade delete. Unique together with `subcontractor_id` |
| can_deliver | boolean | Default true. False is a refusal: the bot may not quote, may not call `extract_order`, and `record_daily_order` writes no date — it escalates instead |
| surcharge_per_delivery | integer | IDR added **per drop, not per portion**, and passed to the customer. Ignored when `can_deliver` is false |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**Matched on the address line, never on `customers.area`/`sub_area`.** Those two disagree with each other for the same place: the two towers of Apartemen Akasa are filed under BSD Lama and BSD Baru, and Evelyn's `sub_area` is "Pakojan" while her address reads "Kost Casa Living 158". `addressMatchesNeighborhood()` anchors the name at a word boundary at the front only — open at the end so "Apartemen Akasa" catches "Apartemen Akasa Tower Kalyana", anchored at the front so "Casa Living" does not catch Valen's "Tucasa Living, Regentown" in a different area entirely.

---

## subcontractor_off_days

Dates when a subcontractor's kitchen is closed.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| subcontractor_id | uuid | FK → subcontractors |
| off_date | date | The date the kitchen is closed |
| reason | text | Why they're off (e.g. "public holiday", "personal") |
| created_by | text | Admin email who added this |
| created_at | timestamp | |

---

## subcontractors

The kitchens (dapur) that cook and deliver the food. Their real names are confidential — only `customer_nickname` is ever shown to customers.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| name | text | Real internal name — never shown to customers |
| customer_nickname | text | Customer-facing name shown in the chatbot (e.g. "Dapur A") |
| admin_phone | text | Primary WhatsApp number for the kitchen admin |
| admin_phone_2 | text | Secondary WhatsApp number |
| delivery_areas | json | Array of area strings **this kitchen** serves. Each kitchen has its own list and the lists overlap only in part; the areas Pian Yi offers are the union of this column across rows with `is_active = true`, computed at read time by `activeDeliveryAreas()` / `unionAreas()` (`src/lib/subcontractors/areas.ts`) and never stored anywhere else. **This column is the only source** — not `settings.delivery_areas` (which exists, is written by nothing that reads it, and is no longer editable in the UI), and not a literal in code. Editing this column, or flipping `is_active`, changes what the chatbot tells customers. See "Delivery areas" in `OPERATIONS.md` |
| cost_per_portion | integer | What we pay per portion in IDR — used for Route 2 (kitchen delivers) |
| cost_per_portion_route1 | integer | Override cost for Route 1 (back when we ran our own courier, cheaper). NULL = same as cost_per_portion, and **null on every kitchen since migration 084** — the courier stopped on 2026-09-01. Per kitchen — never quote a figure from memory, read the row |
| offers_size_m | boolean | Whether this kitchen cooks size M (migration 078). Per kitchen, like `delivery_areas` — only Dapur 1 has it today and nothing may hardcode that. The bot's prompt builds its size section from this column, and `createOrderFromExtraction` re-reads it after resolving the kitchen and downgrades an M order to S rather than sending an M row to a kitchen that cooks S |
| cost_per_portion_m | integer | What we pay per M portion on Route 2. NULL = this kitchen has no M rate on file and M is costed at the S rate |
| cost_per_portion_route1_m | integer | Override M cost for Route 1. NULL falls back to `cost_per_portion_m` **before** the S route-1 rate — a kitchen that quoted a single M price bills it on both routes. All four rates are picked by `kitchenCostPerPortion(sub, size, route)` (`src/lib/orders/size.ts`); never index the columns by hand |
| menu_image_url | text | URL of the current weekly menu image (shown to new customers). Inactive kitchens keep their last image forever — nobody refreshes it once they stop cooking, so every read of this column must filter `is_active = true`. The `send_menu_image` tool did not, and sent customers a live menu plus a two-month-old one. |
| menu_text | text | Plain-text menu description injected into the chatbot system prompt |
| menu_week_start | date | Monday of the week `menu_image_url` covers. Added in migration 066 because nothing recorded the week, so the prompt hardcoded "always the current week" and the bot refused to send an already-uploaded next-week menu. Defaulted on upload by `defaultMenuWeekStart()` (Thursday onward → next week) and editable on the subcontractor form — the upload day is a guess, not the answer. Null means unknown, and the bot then makes no claim about which week it holds. |
| notes | text | Internal notes about this kitchen |
| is_active | boolean | Whether this kitchen is currently accepting orders |
| total_delivery_count | integer | Running total of deliveries completed |
| late_delivery_count | integer | Running total of late deliveries |
| created_at | timestamp | |
| updated_at | timestamp | |

---

# Views

## tasks

The work queue, replacing the old `TASKS.md` on 2026-08-25. A file only Claude could update went stale between sessions and no other admin could ever see it. Edited at `/tasks`, printed by `pnpm tasks`. Statuses are plain text, not an enum — `open | in_progress | blocked | done` — so a new one costs no migration; the allowlist that keeps a typo out lives in `src/app/api/tasks/validate.ts`, and adding a status means adding it there and to both `STATUS_RANK` and `BAND` as well. Nothing at the database level rejects a bad value: a fuzzing pass stored `status: "transcended"` and `priority: 999`, and such a row is then invisible in every filter chip but "All". Priority is 1 (highest) to 3.

`GET /api/tasks` sorts in three bands — blocked, then live work (`open` and `in_progress` together), then done — and compares priority **inside** a band, never across one. Blocked is pinned to the top because those rows wait on a person rather than on code. Until 2026-08-30 status was ranked outright, which put a single blocked priority-2 task above sixteen open priority-1 ones; `in_progress` also outranked `open`, so starting a low-priority task promoted it over urgent work. The `/tasks` table shows priority as its own column rather than the old one-character gutter, which could not distinguish Normal from Low. It reads `P1`/`P2`/`P3` — the same vocabulary as the integer column, the API's own validation error and `pnpm tasks` — while the edit form keeps High/Normal/Low, because choosing a level is the one moment the words are worth the space.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| title | text | Required |
| body | text | Free text — file:line pointers, the incident, whatever the task needs. No markdown renderer exists; it displays as written |
| status | text | `open` (default), `in_progress`, `blocked`, `done` |
| priority | integer | 1 = highest, 2 = default, 3 = lowest |
| area | text | Free label (`bot`, `calendar`, `deferred`, …) — the section headings the old file had |
| assignee | text | Email, or a name. Not FK'd to `admin_users` — a task can name someone before they have a login row |
| customer_id | uuid | FK `customers(id)` `on delete set null` — the task links to a real record, so `/tasks` shows a live link |
| order_id | uuid | FK `orders(id)` `on delete set null` |
| blocked_on | text | What the task is waiting for. Shown in red on the row when `status = 'blocked'` |
| due_date | date | |
| created_at | timestamp | |
| updated_at | timestamp | Set by the route, never a trigger — this schema has none |
| done_at | timestamp | Stamped by the API when status becomes `done`, cleared when it moves back off |

Indexes: `tasks_open_idx (priority, created_at) where status <> 'done'` — the queue read is always the open set — plus `tasks_customer_idx` and `tasks_order_idx`. RLS on, one service-role policy; every read and write goes through `/api/tasks`, which is session-gated and calls `logEdit()`. Tasks are hard-deleted, so DELETE writes the whole prior row into `edit_log.changes`.

---

## inbox_threads

Regular (non-materialized) view, added in migration `059_inbox_threads_view.sql`. Returns exactly one row per customer — that customer's most recent `conversations` row — and backs the admin inbox thread list.

Implemented as `SELECT DISTINCT ON (customer_id) ... ORDER BY customer_id, created_at DESC`, supported by the `conversations_customer_created_idx` index on `(customer_id, created_at DESC)` so the query walks the index instead of sorting the whole table.

Migration `061_inbox_threads_media_url.sql` added `media_url` to the column list. It sits last, not beside `media_id`: `CREATE OR REPLACE VIEW` can only append columns, and inserting one mid-list fails with `cannot change name of view column` (42P16). Any future column goes on the end too, or the view has to be dropped and recreated.

Created `WITH (security_invoker = on)`, so the querying user's RLS applies and it inherits `admins_read_conversations` from `007_rls.sql` rather than bypassing it.

Why it exists: the inbox previously fetched the newest 500 `conversations` rows and grouped them by customer in the browser. Past a few thousand messages that window only covered recently active customers — lapsed customers had no thread at all, and the search box (which filters already-loaded threads) could never find them.

**Do not convert this to a materialized view.** Messages arrive continuously and the inbox is read occasionally, so a matview would pay a full refresh per inbound message to serve a handful of page loads, and would show a stale inbox whenever its refresh lagged or its trigger broke — a silent wrong answer rather than a slow one.
