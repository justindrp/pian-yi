# Pian Yi Catering — Phase 2 Build Brief

Build Phase 2 of Pian Yi Catering's WhatsApp ordering system.

Read `CLAUDE.md` first for full project context. Phase 1 must be fully working before starting Phase 2. This prompt covers Phase 2 only — Phase 3 comes later.

## Starting state assumptions

Phase 1 is complete and working:
- Webhook receiving and processing WhatsApp messages
- Claude Sonnet 4.6 chatbot with Haiku 4.5 preprocessing
- Auth, settings cache, push notifications, kill switch
- Dashboard: Home, Inbox, Customers, Payments, Settings (read-only)
- All Phase 1 tables exist with RLS policies

Do not break or refactor anything from Phase 1 unless explicitly instructed. Build on top of it.

## Phase 2 scope

Operational efficiency. Give Annie the tools she needs to run day-to-day operations smoothly.

### What's in scope for Phase 2

1. **Database migrations** — new columns and tables for Phase 2 features
2. **Order management page** — daily lunch/dinner planning split view
3. **Subcontractor management page** — CRUD for subcontractors
4. **Deliveries page** — two tabs: Daily Sheet + Proof of Delivery
5. **AI photo matching** — Haiku 4.5 auto-matches delivery photos to customers
6. **Chatbot training page** — two modes: conversational interview + list view
7. **Renewal reminders** — two new cron jobs
8. **Full Settings page** — all fields editable with confirmation modals
9. **Reports page** — business analytics and operational metrics
10. **Abandoned cart recovery** — cron job for incomplete orders
11. **Post-delivery follow-up** — automated satisfaction check
12. **Reactivation campaigns** — cron job for lapsed customers

### What's NOT in Phase 2 (save for Phase 3)

- Data export (CSV download)
- Staging environment setup
- Performance monitoring (Sentry, analytics)
- Advanced analytics beyond what's listed
- Customer self-service page

---

## Step 1: Database migrations

Create new migration files under `supabase/migrations/`. Number them sequentially after Phase 1 migrations (e.g., `008_subcontractors.sql`, etc.). After all migrations are applied, run `pnpm db:types` to regenerate types.

### New column: `customers.subcontractor_id`

```sql
ALTER TABLE customers
ADD COLUMN subcontractor_id uuid REFERENCES subcontractors(id) ON DELETE SET NULL;
```

This is the **default subcontractor** assigned to a customer upfront. Create the `subcontractors` table first (see below), then add this column.

### New table: `subcontractors`

- `id` (uuid, primary key, default `gen_random_uuid()`)
- `name` (text, not null) — e.g., "Santapin", "Thenie"
- `admin_phone` (text) — WhatsApp number of their admin, used to identify incoming delivery photos
- `admin_phone_2` (text, nullable) — secondary admin number if they have multiple
- `delivery_areas` (jsonb) — JSON array of areas they serve e.g. `["BSD", "Gading Serpong"]`
- `notes` (text, nullable)
- `is_active` (boolean, default true) — never delete, only deactivate
- `late_delivery_count` (int, default 0) — auto-incremented by delivery log
- `total_delivery_count` (int, default 0)
- `created_at` (timestamptz, default `now()`)
- `updated_at` (timestamptz, default `now()`)

Indexes: `admin_phone`, `is_active`

Seed with Santapin and Thenie (placeholder phone numbers — Justin will fill in real values):

```sql
INSERT INTO subcontractors (name, delivery_areas, notes) VALUES
  ('Santapin', '["BSD","Gading Serpong"]', 'Best taste. Occasionally delivers late.'),
  ('Thenie', '["Alam Sutera","Bintaro","Graha Raya"]', 'Always on time.');
```

### New table: `subcontractor_off_days`

- `id` (uuid, primary key)
- `subcontractor_id` (uuid, references `subcontractors(id)` on delete cascade)
- `off_date` (date, not null)
- `reason` (text, nullable)
- `created_by` (text) — admin email
- `created_at` (timestamptz, default `now()`)

Indexes: `subcontractor_id`, `off_date`

### New table: `daily_deliveries`

One row per customer per meal per date.

- `id` (uuid, primary key)
- `delivery_date` (date, not null)
- `customer_id` (uuid, references `customers(id)`)
- `order_id` (uuid, references `orders(id)`)
- `meal_type` (text) — `lunch` or `dinner`
- `portions` (int, not null)
- `subcontractor_id` (uuid, references `subcontractors(id)`) — can override customer default for this specific day
- `status` (text, default `scheduled`) — `scheduled`, `delivered_on_time`, `delivered_late`, `not_delivered`, `skipped`
- `delivery_proof_id` (uuid, nullable, references `delivery_proofs(id)`)
- `notes` (text, nullable)
- `created_at` (timestamptz, default `now()`)
- `updated_at` (timestamptz, default `now()`)

Unique constraint: `(delivery_date, customer_id, meal_type)` — one row per customer per meal per day.

Indexes: `delivery_date`, `customer_id`, `subcontractor_id`, `status`

### New table: `delivery_proofs`

- `id` (uuid, primary key)
- `received_at` (timestamptz, default `now()`)
- `sender_phone` (text) — the subcontractor admin's WhatsApp number
- `subcontractor_id` (uuid, nullable, references `subcontractors(id)`) — resolved from `sender_phone`
- `whatsapp_message_id` (text, unique) — for idempotency
- `caption` (text, nullable) — caption sent with the photo
- `image_url` (text) — stored in Supabase Storage
- `matched_customer_id` (uuid, nullable, references `customers(id)`)
- `matched_delivery_id` (uuid, nullable, references `daily_deliveries(id)`)
- `match_confidence` (float, nullable) — 0.0 to 1.0
- `match_method` (text, nullable) — `auto` or `manual`
- `status` (text, default `pending`) — `pending`, `auto_sent`, `manually_sent`, `needs_review`, `unmatched`
- `sent_to_customer_at` (timestamptz, nullable)
- `sent_by` (text, nullable) — `system` or admin email

Indexes: `status`, `received_at`, `subcontractor_id`

### New table: `chatbot_instructions`

Annie's custom instructions injected into the chatbot system prompt.

- `id` (uuid, primary key)
- `instruction` (text, not null) — the instruction text
- `description` (text, nullable) — Annie's plain-language summary of what it does
- `is_active` (boolean, default true)
- `created_by` (text) — admin email
- `created_at` (timestamptz, default `now()`)
- `updated_at` (timestamptz, default `now()`)

### New columns: `orders` table

```sql
ALTER TABLE orders
ADD COLUMN reminder_sent_at timestamptz,
ADD COLUMN followup_sent_at timestamptz,
ADD COLUMN abandoned_recovery_sent_at timestamptz;
```

### RLS for new tables

- `subcontractors`: authenticated admins read-all; service role write-all
- `subcontractor_off_days`: authenticated admins read-all; service role write-all
- `daily_deliveries`: authenticated admins read-all and write (via service role for system, direct for admins)
- `delivery_proofs`: authenticated admins read-all; service role write-all
- `chatbot_instructions`: authenticated admins read-all; service role write-all

---

## Step 2: Update settings cache

The settings cache from Phase 1 needs to also load `chatbot_instructions` (active ones only). Expose a `getActiveInstructions()` getter. The webhook's system prompt builder already has a `{custom_instructions}` placeholder — populate it from the cache.

Also update the webhook's system prompt builder to inject active instructions as a numbered list:

```
## Annie's custom instructions
1. [instruction 1]
2. [instruction 2]
...
```

If no active instructions, omit the section entirely.

---

## Step 3: Update webhook for delivery photos

In Phase 1, messages from subcontractor admin numbers were logged and skipped. Now implement the delivery photo flow.

**When a message arrives from a number matching a `subcontractors.admin_phone` or `admin_phone_2`:**

1. Identify the subcontractor from the phone number
2. If message type is `image`:
   - Download the image from WhatsApp media endpoint using the media ID
   - Upload to Supabase Storage bucket `delivery-proofs` with path `{subcontractor_id}/{date}/{message_id}.jpg`
   - Extract caption from the message (may be empty)
   - Create a `delivery_proofs` row with status `pending`
   - Call `matchDeliveryPhoto()` async
3. If message type is `text`:
   - Log as subcontractor message in a dashboard notification
   - Push notify Annie: "Message from [subcontractor name]: [message text]"
   - Do not pass to customer chatbot

### `matchDeliveryPhoto(proofId)`

Uses **Haiku 4.5** to match the photo caption against today's delivery list.

```ts
async function matchDeliveryPhoto(proofId: string): Promise<void> {
  const proof = await getDeliveryProof(proofId);
  const todayDeliveries = await getTodayDeliveries(proof.subcontractor_id);

  if (!proof.caption || todayDeliveries.length === 0) {
    await updateProofStatus(proofId, 'needs_review');
    await sendPushToAllAdmins('Delivery photo needs manual matching', ...);
    return;
  }

  // Build a list of today's customers for this subcontractor
  const customerList = todayDeliveries.map(d =>
    `ID: ${d.customer_id} | Name: ${d.customer_name} | Area: ${d.area}`
  ).join('\n');

  const prompt = `
    You are matching a delivery photo to a customer.
    Photo caption: "${proof.caption}"
    
    Today's customers for this subcontractor:
    ${customerList}
    
    Return JSON only: { "customer_id": "...", "confidence": 0.0-1.0, "reasoning": "..." }
    If no match is confident, return { "customer_id": null, "confidence": 0, "reasoning": "..." }
  `;

  const result = await callHaiku(prompt);
  const match = JSON.parse(result);

  const threshold = parseFloat(await getSetting('photo_match_confidence_threshold')); // 0.95

  if (match.confidence >= threshold && match.customer_id) {
    // Auto-send
    await sendDeliveryPhotoToCustomer(proofId, match.customer_id);
    await updateProof(proofId, {
      matched_customer_id: match.customer_id,
      match_confidence: match.confidence,
      match_method: 'auto',
      status: 'auto_sent',
      sent_to_customer_at: new Date(),
      sent_by: 'system',
    });
  } else if (match.confidence >= 0.7 && match.customer_id) {
    // Queue with pre-selected suggestion
    await updateProof(proofId, {
      matched_customer_id: match.customer_id,
      match_confidence: match.confidence,
      match_method: 'auto',
      status: 'needs_review',
    });
    await sendPushToAllAdmins('Delivery photo needs confirmation', `Suggested: ${match.customer_name}`, '/deliveries', 'medium');
  } else {
    // No match
    await updateProof(proofId, { status: 'needs_review', match_confidence: match.confidence });
    await sendPushToAllAdmins('Delivery photo could not be matched', proof.caption ?? 'No caption', '/deliveries', 'medium');
  }
}
```

### Sending photo to customer

When sending a delivery photo, strip the subcontractor's caption entirely. Send the photo with a friendly Pian Yi-branded caption:

```
Halo kak {customer_name}, pesanan {meal_type} hari ini sudah sampai ya 🍱 Selamat menikmati! 😊
```

Use WhatsApp's `image` message type with `caption` field.

---

## Step 4: New pages

### `/deliveries` — two tabs

#### Tab 1: Daily Sheet

**The most important operational page.** Annie uses this every day at 6-7pm to plan tomorrow's deliveries.

**Header:**
- Date picker (defaults to tomorrow)
- Summary bar: total lunch portions, total dinner portions, portions per subcontractor
- "Save" button (saves all changes at once, not per row)
- "Generate" button — pre-populates the sheet from active subscriptions for the selected date

**Layout:** two columns side by side — Lunch (left) and Dinner (right).

Each column contains a table with one row per customer who is scheduled for that meal on that date. Columns per row:

- Checkbox (checked = will deliver, unchecked = skip)
- Customer name + area
- Portions stepper (-, number, +) — pre-filled from `portions_lunch` or `portions_dinner`, minimum 1
- Subcontractor dropdown — pre-filled from `customers.subcontractor_id` (the default), overridable for this day only
- Notes field (optional, small)

**Pre-population logic (Generate button):**

For the selected date, find all customers with:
- An `active` order
- `pause_until` is null or before the selected date
- `meal_time_preference` matches (lunch, dinner, both, or per_day_decision with a confirmed reply)
- Not on a weekend if their `custom_schedule` excludes weekends

Pre-fill each row's portions from their order's `portions_lunch` / `portions_dinner` / `portions_per_delivery`.
Pre-fill subcontractor from `customers.subcontractor_id`.

**Deadline enforcement:**

If the selected date is tomorrow and current time is past 8pm (`order_deadline_hour` from settings), show a warning banner: "Deadline sudah lewat. Perubahan ini harus dikomunikasikan langsung ke subcontractor." Save is still allowed with the warning.

**Subcontractor off-day warning:**

If a subcontractor marked off for the selected date appears in any row, highlight those rows in amber with: "⚠️ [Subcontractor name] libur hari ini." Annie must reassign those rows manually.

**Save behavior:**

On save, upsert all rows to `daily_deliveries` table. Deduct portions from `orders.portions_remaining` for each saved delivery. Log the action in `edit_log`.

Show confirmation modal before saving: "Simpan pengiriman untuk [date]? Ini akan mengurangi kuota pelanggan."

**Undo:** within 24 hours of saving, a "Undo last save" button appears. Reverts `daily_deliveries` rows and restores `portions_remaining`. After 24 hours, requires password confirmation to edit.

**After save:**

Auto-generate a summary text that Annie can forward to each subcontractor. Format:

```
🍱 *Pengiriman [Santapin] - [Date]*

*LUNCH*
1. Budi - Jl. Sudirman No. 5, BSD - 2 porsi
2. Siti - Jl. Pahlawan No. 12, GS - 1 porsi

*DINNER*
1. Andi - Jl. Merdeka No. 3, BSD - 2 porsi

Total: 5 porsi
```

Show a "Copy for Santapin" and "Copy for Thenie" button that copies this text to clipboard. Annie pastes it into WhatsApp manually.

#### Tab 2: Proof of Delivery

Three sub-sections:

**Auto-matched (sent)** — `delivery_proofs` with status `auto_sent` today, read-only. Shows photo thumbnail, customer name, sent time, confidence score.

**Needs review** — `delivery_proofs` with status `needs_review`. For each:
- Photo displayed
- Caption shown
- If Haiku suggested a match: pre-selected customer in dropdown with confidence badge
- Dropdown to select correct customer (today's delivery list)
- "Send" button → sends photo to selected customer, updates status to `manually_sent`
- "Can't match" button → marks as `unmatched`

**Unmatched** — `delivery_proofs` with status `unmatched`. Archive view.

Real-time updates via Supabase Realtime — when a new photo arrives and is processed, it appears in the correct section automatically.

---

### `/subcontractors`

**List view:**

Table with one row per subcontractor. Columns: name, areas, admin phone, active orders count, late rate (%), active/inactive badge.

"Add subcontractor" button opens a form modal.

**Detail / edit view (slide-over):**

Editable fields:
- Name
- Admin phone + admin phone 2
- Delivery areas (multi-select from the 5 areas)
- Notes
- Active toggle (with confirmation modal: "Menonaktifkan subcontractor ini tidak menghapus data historis.")

**Off days section (within detail view):**

Calendar or list of upcoming off days. "Add off day" button — date picker + reason field. Deletes allowed for future off days only.

**Performance stats (read-only within detail view):**

- Total deliveries
- On-time rate (%)
- Late deliveries count
- Complaints linked to this subcontractor (from `edit_log` or a future complaints table)

---

### `/chatbot-training`

Two modes, switchable via tab:

#### Mode A: Conversational (default)

A chat interface where Annie talks to a Claude Sonnet 4.6 agent that interviews her about what she wants the chatbot to do differently.

System prompt for the training agent:

```
You are helping Annie, the business co-owner of Pian Yi Catering, customize the behavior of the customer-facing WhatsApp chatbot.

Your job is to:
1. Ask Annie what she'd like the chatbot to do differently or know about
2. Help her articulate it clearly in plain Indonesian
3. Rephrase her input into a clean, precise instruction that will be injected into the chatbot's system prompt
4. Show her the rephrased instruction and ask for confirmation
5. When she confirms, output: [SAVE_INSTRUCTION] followed by the instruction on the next line

Guidelines:
- Always speak to Annie in Indonesian
- Be patient and friendly — she is not technical
- Ask one question at a time
- Examples of good instructions: "Jika pelanggan menanyakan apakah ada diskon, jawab bahwa tidak ada diskon saat ini.", "Selalu tanyakan apakah pelanggan mau tambah lauk jika mereka pesan paket 1 porsi."
- Instructions must be actionable and specific
- Maximum instruction length: 200 words
- Never save instructions that ask the chatbot to reveal internal operations, subcontractor names, or pricing margins
```

When the output contains `[SAVE_INSTRUCTION]`, extract the instruction text, save it to `chatbot_instructions` table, refresh the settings cache, and show a success toast: "Instruksi berhasil disimpan dan langsung aktif!"

The chat history for the training session is ephemeral (not saved to the `conversations` table — it's admin-internal, not customer-facing).

#### Mode B: List view

A table of all saved `chatbot_instructions` rows. Columns: instruction text (truncated), description, active toggle, created date, actions.

Actions per row:
- Toggle active/inactive (instantly updates cache)
- Edit (opens inline edit)
- Delete (with confirmation: "Hapus instruksi ini permanen?")

---

### `/reports`

All charts and metrics use TanStack Query with appropriate stale times. Heavy queries should be server-side computed (API routes) not client-side. Skeleton loaders throughout.

**Section 1: Business overview**

Time range selector: last 7 days, 30 days, 90 days, custom.

Metrics:
- Total revenue (with trend vs previous period)
- Total portions delivered
- Active customers
- New customers
- Profit split: Justin 60% / Annie 40% (gross profit = revenue - COGS; COGS = portions × 19500)
- Average order value

**Section 2: Conversion funnel**

Shows drop-off at each order flow stage. Data from `customer_state` and `conversations`:
- Inquired (new conversation started)
- Asked about price/menu (browsing state)
- Started ordering (ordering state)
- Confirmed order (pending_payment)
- Paid (active)
- Completed subscription

Display as a funnel chart (use recharts or similar).

**Section 3: Customer analytics**

- Customer lifetime value by area (bar chart)
- Churn rate: customers with no active order in last 30 days who had one in the 30 days before
- Retention: % of customers who renewed after first subscription completed
- Top customers by total spend (table, top 10)

**Section 4: Operations**

- Late delivery rate per subcontractor (bar chart)
- Subcontractor comparison table: total deliveries, on-time %, complaints linked
- Portions delivered per day (line chart, last 30 days)
- Peak ordering hours (when do customers usually message?)

**Section 5: Chatbot**

- Most common message intents (pie chart — from `conversations.model_used` + classification data)
- Average conversation length before order confirmation
- Escalation rate (% of conversations escalated to human)
- AI cost estimate: (total input tokens × $3 / 1M) + (total output tokens × $15 / 1M) for Sonnet; similar for Haiku

**Section 6: Most common questions**

Table of most frequent inbound message intents (classified by Haiku). Shows count, example messages, suggested FAQ additions. Refreshes weekly.

---

### `/settings` — now fully editable

Replace Phase 1's read-only display with editable forms organized into sections.

**Section: Business info**

Editable: business name, Instagram handle, bank name, bank account number, bank account name.

Confirm before save (all fields): "Simpan perubahan info bisnis?"

**Section: Pricing**

Table with all `pricing_tiers` rows. Each row: portions (read-only), price per portion (editable input). Edit button per row.

Confirmation modal on save: "Perubahan harga hanya berlaku untuk pesanan baru. Pesanan yang sudah ada tidak terpengaruh. Lanjutkan?"

**Section: Delivery**

Editable: delivery areas (multi-select), order deadline hour.

**Section: Chatbot behavior**

Editable sliders/toggles:
- Casual mode probability (slider 0-100%)
- Typing delay base seconds (number input)
- Typing delay per char (number input)
- Typing delay max seconds (number input)
- Photo match confidence threshold (slider 0-100%)
- Chatbot enabled toggle (kill switch — same as home page)

**Section: Automation thresholds**

Editable number inputs:
- Unpaid reminder hours (default 2)
- Unpaid cancel hours (default 24)
- Low quota first warning (default 3)
- Low quota final warning (default 1)

**Section: Escalation keywords**

Editable tag list. Add/remove keywords. Preview of current list.

**Section: Message templates**

Editable text areas for each template. `{variable}` placeholders shown as highlighted tags. Preview button shows how the template looks with sample data.

**Section: Admin users**

Table showing Justin and Annie. Add admin button (for future expansion). Cannot delete your own account.

All settings changes are logged to `edit_log`.

---

## Step 5: New cron jobs

Add to existing cron endpoints. All protected by `CRON_SECRET`.

### `/api/cron/renewal-reminders`

Runs every hour.

Find all `active` orders where `portions_remaining` equals `low_quota_first_warning` (3) and `reminder_sent_at` is null. Send `quota_low_first` template. Set `reminder_sent_at = now()`.

Find all `active` orders where `portions_remaining` equals `low_quota_final_warning` (1) and final reminder not yet sent. Send `quota_low_final` template.

If customer replies "YA" to a renewal reminder, the chatbot's existing order flow handles it — no special cron logic needed.

### `/api/cron/abandoned-recovery`

Runs every hour.

Find all conversations where:
- Customer reached `ordering` state
- No `extract_order` tool call was made
- Last message was more than 2 hours ago
- `abandoned_recovery_sent_at` is null

Send recovery message: "halo kak tadi mau lanjut order ya? tinggal ketik YA aja kalau mau konfirmasi 😊"

Set `abandoned_recovery_sent_at = now()` on the order record.

### `/api/cron/post-delivery-followup`

Runs daily at 3pm WIB (08:00 UTC).

Find all customers who had a delivery today (status `delivered_on_time` or `delivered_late`) and `followup_sent_at` is null, AND random float < 0.2 (20% sample rate, or always for first delivery of new subscription).

Send: "halo kak gimana makanannya hari ini? 🍱"

Set `followup_sent_at = now()`.

When customer replies to a follow-up:
- Use Haiku 4.5 to classify sentiment: `positive`, `neutral`, `negative`
- Positive: "Senang kak suka! 😊 Kalau berkenan, boleh share ke teman-teman ya 🙏"
- Neutral: "Terima kasih feedbacknya kak 😊"
- Negative: immediately escalate to Annie with push notification "Customer [name] gave negative feedback: [message]". Set `escalated_to_human = true`.
- Save sentiment to a new `delivery_feedback` column on `daily_deliveries` (add via migration: `feedback_sentiment text, feedback_message text`)

### `/api/cron/lapsed-customers`

Runs daily at 10am WIB (03:00 UTC).

Find customers with `customer_state.state = 'active_subscription'` who have no active orders (all orders completed or cancelled) for more than 30 days. Update state to `lapsed`.

Find `lapsed` customers where last reactivation message was more than 30 days ago (or never sent):
- 30 days lapsed: "halo kak, udah lama ga order nih. menu lagi banyak yang baru loh, mau coba lagi? 😊"
- 60 days lapsed: "Halo kak, kangen loh sama kakak 😊 Ada yang bisa kami bantu?"
- 90+ days: stop messaging, mark state as `churned`

Add `reactivation_sent_at` and `reactivation_count` columns to `customer_state` via migration.

---

## Step 6: Update existing pages

### Customers page updates

- Add "Assigned subcontractor" field to customer detail view — dropdown of active subcontractors, editable
- Add "Meal time preference" display + edit
- Add "Subscription status" badge (active, lapsed, churned, new)
- Add link to their delivery history (filter of `daily_deliveries` for this customer)

### Inbox page updates

- Add intent badge per message (the Haiku classification result from webhook processing) — small colored tag: FAQ, ordering, complaint, etc.
- Add "Delivery photo" message type rendering — show image inline when `message_type = image`

### Home page updates

- Add "Pending delivery photos" count to stat cards if > 0
- Add "Lapsed customers" count
- Add today's on-time delivery rate if deliveries have been logged

---

## Step 7: Supabase Storage

Create a storage bucket `delivery-proofs`:

```sql
INSERT INTO storage.buckets (id, name, public) VALUES ('delivery-proofs', 'delivery-proofs', false);
```

RLS on storage: only service role can insert; authenticated admins can read. Customers cannot access.

When displaying proof images in the dashboard, generate signed URLs with 1-hour expiry using `supabase.storage.from('delivery-proofs').createSignedUrl(path, 3600)`.

---

## Build order

Work in this order and write a short status note after each milestone:

1. Database migrations (all new tables + columns) → `pnpm db:types`
2. Update settings cache to load `chatbot_instructions`
3. Supabase Storage bucket for delivery proofs
4. Update webhook: subcontractor photo detection → download → upload → create proof → match
5. Delivery photo matching logic (Haiku 4.5)
6. Subcontractor management page (`/subcontractors`)
7. Deliveries page Tab 1: Daily Sheet
8. Deliveries page Tab 2: Proof of Delivery
9. Chatbot training page (`/chatbot-training`) — both modes
10. Full Settings page (all sections editable)
11. Reports page (all 6 sections)
12. New cron jobs (renewal reminders, abandoned recovery, post-delivery followup, lapsed customers)
13. Update existing pages (customers, inbox, home)
14. Final: `pnpm typecheck` + `pnpm lint` — zero errors required

---

## Deliverables checklist

- [ ] All new migrations applied, types regenerated
- [ ] `subcontractors` table seeded with Santapin and Thenie
- [ ] `customers.subcontractor_id` column added
- [ ] Settings cache loads `chatbot_instructions`
- [ ] Webhook handles subcontractor photos end-to-end
- [ ] Haiku 4.5 photo matching with confidence threshold
- [ ] Auto-send at >95% confidence, queue below
- [ ] Delivery photo sent to customer with Pian Yi caption (no subcontractor caption)
- [ ] `/subcontractors` page: list, add, edit, deactivate, off days, performance stats
- [ ] `/deliveries` Tab 1: date picker, generate, lunch/dinner columns, save with confirmation, undo, copy-for-subcontractor text
- [ ] `/deliveries` Tab 2: auto-matched, needs review, unmatched sections with real-time updates
- [ ] Subcontractor off-day warning on daily sheet
- [ ] Deadline warning banner after 8pm
- [ ] `/chatbot-training` Mode A: conversational interview with Claude, saves instructions
- [ ] `/chatbot-training` Mode B: list view with toggle/edit/delete
- [ ] Instructions immediately active after save (cache refresh)
- [ ] `/settings` all sections editable with confirmation modals
- [ ] Pricing change confirmation modal warning about existing orders
- [ ] All settings changes logged to `edit_log`
- [ ] `/reports` all 6 sections with charts
- [ ] Profit split (60/40) shown in reports
- [ ] Cron: renewal reminders at 3 and 1 portions remaining
- [ ] Cron: abandoned cart recovery at 2 hours
- [ ] Cron: post-delivery follow-up at 20% sample rate + first delivery always
- [ ] Cron: lapsed customer reactivation at 30/60/90 days
- [ ] Customers page: subcontractor assignment, meal preference, subscription status
- [ ] Inbox: intent badges, image rendering
- [ ] Home: delivery photo pending count, lapsed customers count
- [ ] Supabase Storage bucket for delivery proofs
- [ ] Signed URLs for proof images in dashboard
- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm lint` passes with zero errors
