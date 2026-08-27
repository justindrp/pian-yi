# Database Tables

26 tables and 1 view in the `public` schema.

---

## accounts

Chart of accounts for double-entry bookkeeping. Key accounts: 1001–1004 (Cash/Banks), 1200 Subcontractor Advance, **1201 Courier Cash Advance (Kasbon Kurir)**, 2001 Accounts Payable, 2100 Unearned Revenue, 4001 Catering Revenue, 5001 Subcontractor Cost.

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
| instruction | text | Natural-language instruction Annie typed (e.g. "remind active customers about weekend menu") |
| message_template | text | Personalized message template Haiku generated |
| filter | json | Criteria used to select recipients |
| recipient_count | integer | How many customers were targeted |
| status | text | "draft", "sent" |
| created_by | text | Admin email who triggered it |
| created_at | timestamp | |

---

## chatbot_instructions

Custom instructions Annie adds via the Chatbot Training page. Active ones are appended to the system prompt at runtime.

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
| content | text | Message text. For image rows this is the **caption**, with the file URL in `media_url`. Rows written before 2026-08-21 (and the menu/price-list sends) hold the URL here instead, which is why the Inbox falls back to it — storing the URL as content dropped the caption from both the Inbox and the model's history, so a late-delivery apology sent to a customer appeared nowhere in the dashboard |
| message_id | text | WhatsApp message ID. Inbound rows save this immediately; outbound rows backfill it after Meta accepts the send so status webhooks can match the row |
| message_type | text | "text" or "image" |
| media_id | text | WhatsApp media ID for inbound media; used by `/api/inbox/media/[mediaId]` proxy. Outbound/manual image rows usually keep this null and store the public URL in `content`. Not durable on its own — Meta deletes inbound media after about a week, so `media_url` is the reference that survives |
| media_url | text | Supabase Storage URL in the private `chat-media` bucket, written by the webhook at receipt time (migration 060) and served through `/api/inbox/chat-media/[...path]`. NULL for rows saved before that, and for rows rescued by `scripts/backfill-chat-media.ts`, which wrote the URL into `content` instead. Kept separate from `content` so captions and `[Dokumen: name]` labels — which the bot reads back as conversation context — are not overwritten |
| intent | text | Haiku classification (e.g. "ordering", "inquiry") |
| model_used | text | Which Claude model replied, "human" for manual/admin-assistant sends, or "system" for automated welcome/menu rows |
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
| escalated_to_human | boolean | True when Annie needs to take over the conversation |
| escalation_reason | text | Why it was escalated |
| last_human_activity_at | timestamptz | Stamped on takeover and each manual reply; bot auto-resumes after 30 min of admin inactivity (`TAKEOVER_INACTIVITY_MINUTES`). NULL means never auto-resume |
| pending_bot_response | boolean | True when bot is waiting for Annie's answer via Inbox |
| pending_bot_question | text | The question the bot needs Annie to answer |
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
| meal_time_preference | text | Default meal preference (e.g. "lunch_only", "both_fixed") |
| custom_schedule | json | Per-weekday schedule if preference is "custom_schedule" |
| subcontractor_id | uuid | FK → subcontractors — which kitchen serves this customer |
| portions_remaining | integer | Dead column — never read it. See the `customers.portions_remaining` rule in `CLAUDE.md`. `orders.portions_remaining` was the same idea one table over and was dropped in migration 074; this one survives only because 27 customers hold a cached balance with no order behind it. Was meant as the total quota balance across all active orders |
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
| notes | text | Internal notes about this customer |
| linked_order_id | uuid | FK → orders, nullable. If set, this customer's daily draws come from someone else's order/quota instead of their own (e.g. a kid drawing from a parent's package) |
| contract_price_per_portion | integer | Negotiated per-portion rate for a corporate customer, in IDR. When set it replaces the `pricing_tiers` lookup entirely and lifts the 5/6 divisibility rule — a company buys box counts, not packages. Read via `contractPrice()` by pricing, payment-size matching and the system prompt. NULL = ordinary tier pricing, which is every customer but PT Bintang Lautan |
| created_at | timestamp | |
| updated_at | timestamp | |

---

## daily_deliveries

One row per delivery event. Created when a customer requests a delivery for a specific day.

**The row is the state.** Present means this food will be cooked and delivered; absent means it will not. There is no `status` column — it was dropped in migration 074 after holding `'scheduled'` on all 2937 rows it ever had, while seven read paths each carved out values nothing ever wrote. A skip is a `DELETE` through `deleteDelivery()` (`src/lib/orders/delivery-state.ts`), which copies the row into `edit_log` first; deleting it is also what returns the portion, since every balance is `package_size` minus the rows that exist. Delivered-vs-scheduled is derived from the date (`date <= today`), and whether the booking is still cancellable from `isLocked()` (D-1 16:00 WIB).

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
| size | text | Portion size: "s" (standard) or "m" (medium, +Rp 2,000/portion) — default "s" |
| price_per_portion | integer | Locked-in price in IDR at order time (includes size surcharge if "m") |
| total_price | integer | Total amount due in IDR |
| source | text | "purchase" (default) or "free_quota" — free_quota rows are admin-granted goodwill/compensation portions (price_per_portion 0, total_price 0), created via `POST /api/customers/free-quota` |
| grant_reason | text | Nullable. Why a free_quota order was granted (e.g. "late delivery compensation") |
| granted_by | text | Nullable. Admin email who granted a free_quota order |
| addon_cost_per_portion | integer | What the kitchen charges us extra per portion for an add-on (e.g. nasi merah, Rp 5.000). Cost side only — the customer's share of it is already inside `price_per_portion`. Added to the subcontractor's route rate by the COGS journal and by the `/dapur/[id]` bill. Edited as "Tambahan / porsi" on the new-order modal and the Orders slide-over; per order, so it does not carry to the customer's next package |
| amount_paid | integer | IDR received against this order so far, default 0. For DP / partial payment on corporate orders; `total_price` stays the contracted amount. Set by an admin in the Orders slide-over ("Sudah dibayar") — nothing derives it and nothing gates on it |
| lunch_address_slot | smallint | Standing address slot for lunch deliveries: 1 = primary, 2 = secondary (customers.address_2) — default 1. Generated daily_deliveries rows inherit it; per-day sheet flip overrides |
| dinner_address_slot | smallint | Standing address slot for dinner deliveries: 1 = primary, 2 = secondary — default 1 |
| meal_time_preference | text | Nullable. "lunch_only", "dinner_only", "both_fixed", "per_day_decision", "default_lunch", "default_dinner", "custom_schedule" — null for scheduled orders |
| custom_schedule | json | Per-weekday schedule if preference is "custom_schedule" |
| start_date | date | First delivery date |
| end_date | date | Last requested delivery date |
| payment_proof_url | text | URL of payment transfer screenshot |
| pause_until | date | If paused, resume from this date |
| cancellation_reason | text | Why it was cancelled |
| reminder_sent_at | timestamp | When the payment reminder was last sent |
| abandoned_recovery_sent_at | timestamp | When the re-engagement message was sent |
| followup_sent_at | timestamp | When the post-delivery satisfaction follow-up was sent |
| confirmed_at | timestamp | When the customer confirmed the order with "YA" |
| paid_at | timestamp | When payment was verified |
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

Notable keys: `business_name`, `chatbot_enabled`, `welcome_message`, `price_list_image_url`, `bank_name`, `bank_account_number`, `bank_account_name`, `order_deadline_hour`, `order_deadline_daily_hour`, `casual_mode_probability`, `typing_delay_base_seconds`, `escalation_keywords`, `instagram_handle`

`welcome_message` supports four template placeholders resolved at send time: `{{dapur_list}}` (active subcontractor names), `{{delivery_areas}}` (unique delivery areas from active subcontractors), `{{price_20}}` (20-portion tier price formatted as e.g. `27RB`), `{{order_deadline}}` (order_deadline_hour formatted as e.g. `16.00`). `price_list_image_url` is sent automatically to new WhatsApp contacts before the AI reply; keep it synced with the current Paket Personal S price list.

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
| cost_per_portion_route1 | integer | Override cost for Route 1 (we use own courier, cheaper). NULL = same as cost_per_portion. Per kitchen — never quote a figure from memory, read the row |
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

The work queue, replacing the old `TASKS.md` on 2026-08-25. A file only Claude could update went stale between sessions and no other admin could ever see it. Edited at `/tasks`, printed by `pnpm tasks`. Statuses are plain text, not an enum — `open | in_progress | blocked | done` — so a new one costs no migration; the allowlist that keeps a typo out lives in `src/app/api/tasks/validate.ts`, and adding a status means adding it there and to `STATUS_RANK` as well. Nothing at the database level rejects a bad value: a fuzzing pass stored `status: "transcended"` and `priority: 999`, and such a row is then invisible in every filter chip but "All". Priority is 1 (highest) to 3.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| title | text | Required |
| body | text | Free text — file:line pointers, the incident, whatever the task needs. No markdown renderer exists; it displays as written |
| status | text | `open` (default), `in_progress`, `blocked`, `done` |
| priority | integer | 1 = highest, 2 = default, 3 = lowest |
| area | text | Free label (`bot`, `calendar`, `deferred`, …) — the section headings the old file had |
| assignee | text | Email, or a name. Not FK'd to `admin_users` — a task can be on Annie before she has a login row |
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
