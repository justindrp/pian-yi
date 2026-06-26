# Database Tables

26 tables in the `public` schema.

---

## accounts

Chart of accounts for double-entry bookkeeping.

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

People who can log in to the dashboard. Email is the primary key (matches Supabase Auth).

| Column | Type | Notes |
|--------|------|-------|
| email | text | Primary key — must match a Supabase Auth account |
| name | text | Display name |
| role | text | `"owner"` or `"admin"` — owners have full access, admins are blocked from Accounting |
| created_at | timestamp | |

---

## assistant_conversations

A dashboard Admin Assistant chat thread. Shared across all admins (not per-user).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| title | text | Auto-set from first user message (truncated ~40 chars); editable via PATCH |
| created_at | timestamptz | |
| updated_at | timestamptz | Bumped on every persisted turn |

## assistant_messages

One row per message in an Assistant thread (user or assistant).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| conversation_id | uuid | FK → assistant_conversations (cascade delete) |
| role | text | `"user"` or `"assistant"` |
| content | text | Message text |
| created_at | timestamptz | Ordering within a thread |

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

## conversations

Full chat history between customers and the bot. Append-only — never updated or deleted.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| customer_id | uuid | FK → customers |
| role | text | "user" or "assistant" |
| content | text | Message text |
| message_id | text | WhatsApp message ID (for user messages) |
| message_type | text | "text" or "image" |
| intent | text | Haiku classification (e.g. "ordering", "inquiry") |
| model_used | text | Which Claude model replied, or "human" for manual replies |
| input_tokens | integer | Tokens consumed on input (assistant turns) |
| output_tokens | integer | Tokens produced on output (assistant turns) |
| created_at | timestamp | |

---

## customer_flags

One row per customer. Holds boolean flags and escalation state. Users cannot edit this table directly.

| Column | Type | Notes |
|--------|------|-------|
| customer_id | uuid | Primary key, FK → customers |
| escalated_to_human | boolean | True when Annie needs to take over the conversation |
| escalation_reason | text | Why it was escalated |
| last_human_activity_at | timestamptz | Stamped on takeover and each manual reply; bot auto-resumes after 15 min inactivity |
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

One row per customer. Tracks where the customer is in the conversation flow.

| Column | Type | Notes |
|--------|------|-------|
| customer_id | uuid | Primary key, FK → customers |
| state | text | Current state: "new", "ordering", "awaiting_payment", "payment_proof_received", etc. |
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
| phone_number | text | WhatsApp number in international format (+628...) |
| name | text | Full name (filled in when they place an order) |
| address | text | Delivery address |
| area | text | Delivery zone (e.g. "BSD Baru", "Gading Serpong") |
| sub_area | text | Sub-location within the area: district name for houses, apartment name for apartments, building name for offices |
| address_type | text | "house", "apartment", or "office" — classified by Sonnet at order time |
| google_maps_link | text | Google Maps URL for the delivery address |
| delivery_phone | text | Alternative phone number for delivery if different |
| meal_time_preference | text | Default meal preference (e.g. "lunch_only", "both_fixed") |
| custom_schedule | json | Per-weekday schedule if preference is "custom_schedule" |
| subcontractor_id | uuid | FK → subcontractors — which kitchen serves this customer |
| portions_remaining | integer | Total quota balance across all active orders — decremented with each delivery |
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
| created_at | timestamp | |
| updated_at | timestamp | |

---

## daily_deliveries

One row per delivery event. Created when a customer requests a delivery for a specific day.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| order_id | uuid | FK → orders |
| customer_id | uuid | FK → customers |
| subcontractor_id | uuid | FK → subcontractors — which kitchen fulfills this delivery |
| delivery_date | date | Date of delivery (YYYY-MM-DD) |
| meal_type | text | "lunch", "dinner", or "both" |
| portions | integer | Number of portions for this delivery |
| address_slot | smallint | Which customer address to deliver to: 1 = primary, 2 = secondary (default 1) |
| status | text | "scheduled", "delivered", "cancelled" |
| notes | text | Special instructions |
| delivery_proof_id | uuid | FK → delivery_proofs — photo proof from subcontractor |
| feedback_message | text | Customer's post-delivery feedback text |
| feedback_sentiment | text | Haiku sentiment classification of feedback |
| created_at | timestamp | |
| updated_at | timestamp | |

---

## delivery_proofs

Photos sent by subcontractors via WhatsApp as proof of delivery. Haiku matches each photo to a daily delivery.

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

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| entity_type | text | Table that was changed (e.g. "orders", "subcontractors") |
| entity_id | text | ID of the record that was changed |
| action | text | "create", "update", or "delete" |
| changed_by | text | Admin email |
| changes | json | Before/after values of changed fields |
| created_at | timestamp | |

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
| source_type | text | What generated this entry (e.g. "order", "manual") |
| source_id | text | ID of the source record (e.g. order ID) |
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

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| customer_id | uuid | FK → customers |
| subcontractor_id | uuid | FK → subcontractors — which kitchen fulfills this order |
| order_type | text | "recurring" (cron auto-generates daily rows) or "scheduled" (daily rows inserted at order creation) — default "recurring" |
| status | text | "pending_payment", "payment_proof_received", "active", "paused", "completed", "cancelled_unpaid", "cancelled_by_customer", "cancelled_by_admin", "refunded" |
| package_size | integer | Total portions bought (e.g. 20) |
| portions_per_delivery | integer | Portions per meal per delivery (e.g. 1 or 2) |
| portions_lunch | integer | Portions at lunch (for fixed both_fixed orders) |
| portions_dinner | integer | Portions at dinner (for fixed both_fixed orders) |
| portions_remaining | integer | Quota balance — decremented with each delivery |
| size | text | Portion size: "s" (standard) or "m" (medium, +Rp 2,000/portion) — default "s" |
| price_per_portion | integer | Locked-in price in IDR at order time (includes size surcharge if "m") |
| total_price | integer | Total amount due in IDR |
| addon_cost_per_portion | integer | Extra cost per portion if applicable |
| meal_time_preference | text | Nullable. "lunch_only", "dinner_only", "both_fixed", "per_day_decision", "default_lunch", "default_dinner", "custom_schedule" — null for scheduled orders |
| custom_schedule | json | Per-weekday schedule if preference is "custom_schedule" |
| delivery_address | text | Street address |
| maps_link | text | Google Maps link |
| area | text | Delivery zone |
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

Price per portion at each quantity tier. The `portions` column is the minimum quantity to qualify.

| Column | Type | Notes |
|--------|------|-------|
| portions | integer | Primary key — minimum package size to get this price |
| price_per_portion | integer | Price in IDR per portion at this tier |
| updated_at | timestamp | |

Current tiers: 1→32k, 2→31k, 5→30k, 10→29k, 20→28k, 40→27k, 80→26k

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

## push_subscriptions

Browser push notification subscriptions (Web Push / VAPID) for admin devices.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| user_email | text | Admin email who subscribed |
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

`welcome_message` supports four template placeholders resolved at send time: `{{dapur_list}}` (active subcontractor names), `{{delivery_areas}}` (unique delivery areas from active subcontractors), `{{price_20}}` (20-portion tier price formatted as e.g. `27RB`), `{{order_deadline}}` (order_deadline_hour formatted as e.g. `16.00`).

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
| delivery_areas | json | Array of area strings this kitchen serves (e.g. ["BSD Baru", "Gading Serpong"]) |
| cost_per_portion | integer | What we pay this kitchen per portion in IDR |
| menu_image_url | text | URL of the current weekly menu image (shown to new customers) |
| menu_text | text | Plain-text menu description injected into the chatbot system prompt |
| notes | text | Internal notes about this kitchen |
| is_active | boolean | Whether this kitchen is currently accepting orders |
| total_delivery_count | integer | Running total of deliveries completed |
| late_delivery_count | integer | Running total of late deliveries |
| created_at | timestamp | |
| updated_at | timestamp | |
