# Pian Yi Catering — Phase 1 Build Brief

Build Phase 1 of Pian Yi Catering's WhatsApp ordering system.

Read `CLAUDE.md` first for full project context. This prompt covers Phase 1 only — Phases 2 and 3 will come later.

## Starting state

The project scaffold was created with `pnpm create next-app` using Next.js 16.2.6. The following are **already set up** — do not reinstall, reinitialize, or reconfigure them:

- **Next.js 16.2.6** — confirmed in `package.json`
- **pnpm** — `pnpm-lock.yaml` present, no other lockfiles
- **Biome 2.2.0** — `biome.json` fully configured with formatter, linter, Next.js + React domains, organize imports
- **`lint` and `format` scripts** — already in `package.json`
- **Tailwind CSS** — installed and configured
- **TypeScript 5** — installed, strict mode assumed
- **React 19.2.4** — installed
- **`AGENTS.md`** — scaffolded by Next.js 16, imported by `CLAUDE.md` via `@AGENTS.md`

## Step 1: Add missing scripts to package.json

The following scripts are missing. Add them to the `scripts` section:

```json
"typecheck": "tsc --noEmit",
"db:types": "supabase gen types typescript --linked > src/types/database.ts",
"db:reset": "supabase db reset",
"db:push": "supabase db push"
```

## Step 2: Install project dependencies

Install all required packages using pnpm:

```bash
# Core dependencies
pnpm add @supabase/supabase-js @supabase/ssr @anthropic-ai/sdk web-push

# WhatsApp webhook utilities
pnpm add axios

# UI and data fetching
pnpm add @tanstack/react-query @tanstack/react-query-devtools
pnpm add class-variance-authority clsx tailwind-merge lucide-react
pnpm add next-pwa

# shadcn/ui (run init first, then add components as needed)
pnpm dlx shadcn@latest init

# Dev dependencies
pnpm add -D @types/web-push supabase
```

After installing, run `pnpm typecheck` to confirm TypeScript is happy before proceeding.

## Step 3: Supabase setup via CLI

Initialize Supabase in the project:

```bash
pnpm supabase init
pnpm supabase login
pnpm supabase link  # links to the existing Supabase project
```

Then create all migrations under `supabase/migrations/`. Each logical group of tables should be a separate migration file. After pushing migrations, generate types:

```bash
pnpm supabase db push
pnpm db:types
```

## Phase 1 scope

Foundational build. Get the chatbot working end-to-end with a minimal dashboard. No advanced features yet.

### What's in scope for Phase 1

1. Missing scripts and dependency installation
2. Supabase CLI setup (migrations, RLS, seed data, type generation)
3. Auth (magic link login for admins only)
4. WhatsApp webhook (signature verification, idempotency, async processing)
5. Claude Sonnet 4.6 chatbot with Haiku 4.5 preprocessing:
   - Order flow with lunch/dinner preference handling
   - Rate limits, circuit breaker, echo detection
   - Casual/polished mode randomization (50% on conversational only)
   - Dynamic typing delay (3s base + 0.05s/char, max 12s)
   - Settings/templates fetched from database, cached in memory
6. Minimal dashboard with 4 pages:
   - **Home**: today's metrics (active customers, pending payments, today's deliveries count, today's revenue)
   - **Inbox**: live conversation view with manual takeover
   - **Customers**: paginated list and detail view, edit address/name/area
   - **Payments**: verify payment proofs and mark paid
7. Auth-protected admin layout
8. Settings page (read-only for Phase 1, edits in Phase 2)
9. Push notification subscription setup via `web-push`
10. Kill switch toggle (chatbot on/off)
11. GitHub repo setup via `gh` CLI
12. Railway deployment configuration and instructions

### What's NOT in Phase 1 (save for later)

- Order management page (lunch/dinner split view)
- Subcontractor management page
- Daily delivery sheet
- Photo proof of delivery (subcontractor photo flow)
- AI photo matching
- Reports & analytics
- Chatbot training mode
- Renewal reminders cron jobs
- Marketing automation
- Data export
- Multi-language detection

## Database schema

Create migrations via Supabase CLI under `supabase/migrations/`. Use UUIDs as primary keys throughout. Add indexes as specified. After all migrations are pushed, run `pnpm db:types` to regenerate `src/types/database.ts`.

### `customers`

- `id` (uuid, primary key, default `gen_random_uuid()`)
- `phone_number` (text, unique, not null) — international format `+628xxx`
- `name` (text)
- `address` (text)
- `area` (text) — one of: BSD, Gading Serpong, Alam Sutera, Bintaro, Graha Raya
- `meal_time_preference` (text)
- `custom_schedule` (jsonb, nullable)
- `delivery_phone` (text, nullable)
- `created_at` (timestamptz, default `now()`)
- `updated_at` (timestamptz, default `now()`)

Indexes: `phone_number`, `area`, `created_at`

### `customer_rate_limits`

Separate table — never writable by users or customer-editable endpoints.

- `customer_id` (uuid, primary key, references `customers(id)` on delete cascade)
- `daily_message_count` (int, default 0)
- `daily_token_count` (int, default 0)
- `minute_message_count` (int, default 0)
- `last_message_at` (timestamptz)
- `last_reset_at` (timestamptz, default `now()`)

### `customer_flags`

Separate table — system-controlled only.

- `customer_id` (uuid, primary key, references `customers(id)` on delete cascade)
- `is_blacklisted` (boolean, default false)
- `is_suspicious` (boolean, default false)
- `needs_human_review` (boolean, default false)
- `vip_status` (boolean, default false)
- `escalated_to_human` (boolean, default false)
- `escalation_reason` (text)
- `created_at` (timestamptz, default `now()`)

### `customer_state`

- `customer_id` (uuid, primary key, references `customers(id)` on delete cascade)
- `state` (text) — `new`, `browsing`, `ordering`, `awaiting_payment`, `active_subscription`, `lapsed`
- `updated_at` (timestamptz, default `now()`)

### `conversations`

- `id` (uuid, primary key)
- `customer_id` (uuid, references `customers(id)` on delete cascade)
- `role` (text) — `user`, `assistant`, `system`
- `content` (text)
- `message_id` (text, unique, nullable)
- `model_used` (text, nullable) — `sonnet-4-6` or `haiku-4-5`
- `input_tokens` (int, nullable)
- `output_tokens` (int, nullable)
- `created_at` (timestamptz, default `now()`)

Indexes: `customer_id`, `created_at`, `message_id`

### `orders`

- `id` (uuid, primary key)
- `customer_id` (uuid, references `customers(id)`)
- `package_size` (int) — 1, 2, 5, 10, 20, 40, 80
- `price_per_portion` (int) — locked at order time, server-set
- `total_price` (int) — server-calculated, never from client input
- `portions_per_delivery` (int)
- `portions_lunch` (int, default 0)
- `portions_dinner` (int, default 0)
- `portions_remaining` (int)
- `delivery_address` (text)
- `area` (text)
- `meal_time_preference` (text)
- `custom_schedule` (jsonb, nullable)
- `start_date` (date)
- `pause_until` (date, nullable)
- `status` (text) — `pending_payment`, `payment_proof_received`, `active`, `paused`, `completed`, `cancelled_unpaid`, `cancelled_by_customer`, `cancelled_by_admin`, `refunded`
- `confirmed_at` (timestamptz, nullable)
- `paid_at` (timestamptz, nullable)
- `completed_at` (timestamptz, nullable)
- `cancelled_at` (timestamptz, nullable)
- `cancellation_reason` (text, nullable)
- `created_at` (timestamptz, default `now()`)
- `updated_at` (timestamptz, default `now()`)

Indexes: `customer_id`, `status`, `start_date`, `created_at`

### `processed_messages`

Append-only. Used for idempotency.

- `message_id` (text, primary key)
- `received_at` (timestamptz, default `now()`)
- `processed_at` (timestamptz, nullable)
- `error` (text, nullable)

Index: `message_id` (already primary key, but confirm it's used in queries)

### `push_subscriptions`

- `id` (uuid, primary key)
- `user_email` (text)
- `endpoint` (text)
- `p256dh` (text)
- `auth` (text)
- `created_at` (timestamptz, default `now()`)
- `last_used_at` (timestamptz)

### `settings`

- `key` (text, primary key)
- `value` (text)
- `description` (text)
- `updated_at` (timestamptz, default `now()`)
- `updated_by` (text, nullable)

### `pricing_tiers`

- `portions` (int, primary key)
- `price_per_portion` (int)
- `updated_at` (timestamptz)

### `message_templates`

- `key` (text, primary key)
- `template` (text) — supports `{variable}` substitution
- `description` (text)
- `updated_at` (timestamptz)

### `edit_log`

Append-only audit trail.

- `id` (uuid, primary key)
- `entity_type` (text)
- `entity_id` (text)
- `action` (text) — `create`, `update`, `delete`
- `changed_by` (text)
- `changes` (jsonb)
- `created_at` (timestamptz, default `now()`)

### `admin_users`

- `email` (text, primary key)
- `name` (text)
- `role` (text) — `owner`, `admin`
- `created_at` (timestamptz)

## Seed data

Put all seed data in `supabase/seed.sql`. This file runs automatically on `supabase db reset`.

### settings seed

```sql
INSERT INTO settings (key, value, description) VALUES
  ('bank_account_number', '4971805760', 'BCA account number for payments'),
  ('bank_account_name', 'Daniel Rahardyan Pramadyo', 'Account holder name'),
  ('bank_name', 'BCA', 'Bank name'),
  ('business_name', 'Pian Yi Catering', 'Display name for messages'),
  ('instagram_handle', '@pianyicatering', 'Instagram for menu reference'),
  ('typing_delay_base_seconds', '3', 'Base typing delay before sending'),
  ('typing_delay_per_char_seconds', '0.05', 'Extra delay per character'),
  ('typing_delay_max_seconds', '12', 'Maximum typing delay cap'),
  ('casual_mode_probability', '0.5', 'Probability of casual tone (0-1)'),
  ('photo_match_confidence_threshold', '0.95', 'Auto-send threshold for delivery photos'),
  ('unpaid_reminder_hours', '2', 'Hours before first payment reminder'),
  ('unpaid_cancel_hours', '24', 'Hours before auto-cancel unpaid order'),
  ('low_quota_first_warning', '3', 'Portions remaining for first renewal warning'),
  ('low_quota_final_warning', '1', 'Portions remaining for final renewal warning'),
  ('order_deadline_hour', '20', 'Cutoff hour for next-day orders (24h format)'),
  ('delivery_areas', '["BSD","Gading Serpong","Alam Sutera","Bintaro","Graha Raya"]', 'Served areas as JSON array'),
  ('escalation_keywords', '["manusia","admin","CS","ngomong sama orang","bukan bot","complain","komplain"]', 'Keywords that trigger human escalation'),
  ('chatbot_enabled', 'true', 'Kill switch for AI chatbot');
```

### pricing_tiers seed

```sql
INSERT INTO pricing_tiers (portions, price_per_portion) VALUES
  (1, 30000), (2, 29000), (5, 28000), (10, 27000),
  (20, 26000), (40, 25000), (80, 24000);
```

### message_templates seed

```sql
INSERT INTO message_templates (key, template, description) VALUES
  ('subcontractor_libur', 'Halo kak, mohon maaf dapur kami yang biasanya besok libur, besok kita akan kirim dari dapur yang satunya lagi', 'When subcontractor is unavailable'),
  ('late_delivery', 'Mohon maaf kak pengantaran hari ini agak telat ya. Dapur kami lagi agak ramai. Terima kasih kesabarannya 🙏', 'Apology for late delivery'),
  ('food_complaint_initial', 'Mohon maaf sekali kak atas pengalaman tidak menyenangkan ini 🙏 Boleh saya minta fotonya supaya bisa kami evaluasi langsung dengan dapur kami? Kami akan segera tindak lanjuti.', 'Initial response to food quality complaint'),
  ('out_of_area', 'Mohon maaf kak, saat ini kami hanya melayani BSD, GS, Alsut, Bintaro, dan Graha Raya ya 🙏', 'Customer outside delivery area'),
  ('payment_reminder_gentle', 'Halo kak, belum sempat transfer ya? Kalau butuh info lagi saya siap bantu 😊', 'Gentle payment reminder at 2h'),
  ('payment_overdue_final', 'Halo kak, pesanannya kami batalkan dulu ya karena belum ada pembayaran. Kalau masih berminat, silakan hubungi kami lagi 🙏', 'Final notice before auto-cancel at 24h'),
  ('quota_low_first', 'Halo kak, paket kakak tinggal {remaining} porsi lagi 🍱. Mau renewal biar nggak putus? Reply YA ya 😊', 'First quota warning at 3 portions'),
  ('quota_low_final', 'Halo kak, paket kakak tinggal {remaining} porsi lagi nih. Mau lanjut? Reply YA untuk renewal 😊', 'Final quota warning at 1 portion'),
  ('chatbot_unavailable', 'Halo kak! Sistem kami sedang gangguan sebentar. Kak Annie akan balas langsung secepatnya ya 🙏', 'Fallback when Claude API is down'),
  ('rate_limit_exceeded', 'Halo kak, sistem kami sedang sibuk. Kak Annie akan segera membalas ya 🙏', 'Customer hit rate limit'),
  ('text_only', 'Maaf kak, saya hanya bisa memproses pesan teks ya. Boleh diketik pesannya? 🙏', 'Non-text message received'),
  ('human_escalation', 'Mohon maaf kak, untuk hal ini saya akan hubungkan dengan tim kami ya. Kami akan segera menghubungi kakak. Terima kasih atas kesabarannya! 🙏', 'Escalation to human agent'),
  ('after_hours', 'Halo kak, karena sudah lewat deadline jam 8 malam, pesanan bisa diproses untuk lusa ya. Mau lanjut? 😊', 'Order after 8pm cutoff');
```

## RLS policies

All migrations. Default deny all, then allow selectively:

- `customers`, `orders`, `conversations`: authenticated admins read-all; service role write-all
- `customer_rate_limits`, `customer_flags`, `customer_state`: service role only (no user access at all)
- `push_subscriptions`: authenticated user insert/delete their own row; service role full access
- `settings`, `pricing_tiers`, `message_templates`: authenticated admins read; service role write
- `processed_messages`, `edit_log`: service role insert only; authenticated admins read
- `admin_users`: authenticated user can read their own row; service role full access

## Environment variables

Create `.env.example`:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# WhatsApp
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=1124343560763199
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_API_VERSION=v25.0

# Anthropic
ANTHROPIC_API_KEY=
CLAUDE_SONNET_MODEL=claude-sonnet-4-6
CLAUDE_HAIKU_MODEL=claude-haiku-4-5

# Push notifications
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:justin@pianyicatering.com

# Cron protection
CRON_SECRET=

# App
NEXT_PUBLIC_APP_URL=
```

Generate VAPID keys with:
```bash
node -e "const webpush = require('web-push'); const keys = webpush.generateVAPIDKeys(); console.log(keys);"
```

## Webhook implementation

### `GET /api/webhook/whatsapp`

Verify Meta's challenge. Match `hub.verify_token` against `WHATSAPP_VERIFY_TOKEN`. Return `hub.challenge` as plain text.

### `POST /api/webhook/whatsapp`

**Return HTTP 200 immediately** before any processing:

```ts
export async function POST(req: NextRequest) {
  // Step 1: Acknowledge immediately
  const body = await req.text();
  
  // Verify signature synchronously before acknowledging
  const signature = req.headers.get('x-hub-signature-256');
  if (!verifySignature(body, signature)) {
    return new Response('Forbidden', { status: 403 });
  }

  // Return 200 immediately
  const response = new Response('OK', { status: 200 });
  
  // Process asynchronously after response is sent
  processWebhookAsync(JSON.parse(body)).catch(console.error);
  
  return response;
}
```

**`processWebhookAsync` steps:**

1. Parse message from webhook payload
2. Check `processed_messages` for `message_id` — if exists, return early (idempotency)
3. Insert into `processed_messages` immediately to claim it
4. If message is from Pian Yi's own phone number ID, skip
5. If sender matches a known subcontractor admin phone — log and skip (Phase 2)
6. Read `chatbot_enabled` from settings cache — if false, send `chatbot_unavailable` template and return
7. If message type is not `text` and customer state is not `awaiting_payment` — send `text_only` template and return
8. Upsert customer record by phone number (create if new, update `updated_at` if exists)
9. Upsert companion rows in `customer_rate_limits`, `customer_flags`, `customer_state` for new customers
10. Check `escalated_to_human` flag — if true, log message for Annie's inbox, skip Claude, push notify Annie
11. Check rate limits — if exceeded, send `rate_limit_exceeded` template, push notify Annie
12. Check prompt injection patterns — if detected, send template, flag `is_suspicious`, skip Claude
13. Use **Haiku 4.5** to classify message intent (FAQ, ordering, complaint, other) — single fast call
14. Load last 20 messages from `conversations` for this customer
15. Build system prompt dynamically from settings cache + pricing tiers + templates + custom instructions
16. Flip coin for casual/polished mode (use `casual_mode_probability` from settings)
17. Call **Sonnet 4.6** with `max_tokens=1000`, pass tool definitions
18. Check for echo (response === last assistant message) — if true, log, push notify Annie, abort send
19. Save user message and assistant response to `conversations` table with `model_used`, `input_tokens`, `output_tokens`
20. Update `customer_rate_limits` counters
21. Update `customer_state` based on conversation progress
22. If Claude used a tool, handle it:
    - `extract_order` → create order record in DB with server-calculated `total_price`, update customer state to `awaiting_payment`
    - `escalate_to_human` → set `escalated_to_human` flag, push notify Annie with reason
    - `mark_payment_proof_received` → update order status to `payment_proof_received`, push notify Annie
23. Calculate typing delay: `min(base + (responseLength * perChar), max)` in seconds
24. Send WhatsApp `typing_on` indicator
25. Wait for typing delay
26. Send WhatsApp text message
27. Update `processed_messages.processed_at`

## Claude tool definitions

```ts
const tools = [
  {
    name: 'extract_order',
    description: 'Called when customer has confirmed their order summary with YA. Extracts all order details.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        package_size: { type: 'number', enum: [1, 2, 5, 10, 20, 40, 80] },
        portions_per_delivery: { type: 'number' },
        portions_lunch: { type: 'number' },
        portions_dinner: { type: 'number' },
        address: { type: 'string' },
        area: { type: 'string', enum: ['BSD', 'Gading Serpong', 'Alam Sutera', 'Bintaro', 'Graha Raya'] },
        meal_time_preference: { type: 'string' },
        custom_schedule: { type: 'object', nullable: true },
        start_date: { type: 'string', description: 'ISO date string YYYY-MM-DD' },
      },
      required: ['customer_name', 'package_size', 'portions_per_delivery', 'address', 'area', 'meal_time_preference', 'start_date'],
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Called when the conversation should be handed off to Annie.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'mark_payment_proof_received',
    description: 'Called when customer indicates they have sent payment proof.',
    input_schema: { type: 'object', properties: {} },
  },
];
```

## System prompt (Sonnet 4.6)

Built dynamically in `src/lib/claude/prompts/system.ts`. Assembled from settings cache at runtime:

```text
You are the WhatsApp customer service AI for {business_name}, a daily catering service in Tangerang Selatan, Indonesia.

Always respond in Indonesian. Use "kak" as honorific. Keep replies under 200 words. {mode_instruction}

## Business info
- Areas served: {delivery_areas}
- Every portion includes: nasi + 3 lauk (no sayur, no sambal)
- Free delivery (ongkir gratis)
- Halal
- Menu rotates daily — direct customers to Instagram {instagram_handle} for the weekly menu
- Payment via {bank_name} transfer to {bank_account_number} (a.n. {bank_account_name})
- Order deadline: 8pm the day before delivery

## Pricing (per portion)
{pricing_tiers}

## Order flow
Collect in this order: name → address → area → package size → meal time preference → portions per delivery → start date.

For meal time, ask: "Buat porsinya mau dikirim pas lunch atau dinner kak?"
- If customer is unsure, offer three options: fixed schedule, default with daily overrides, or decide each day
- If both lunch and dinner, ask how many portions for each

Show a summary and ask customer to confirm with YA before calling extract_order tool.

## After order confirmation
After customer says YA, call extract_order tool, then send payment details:
"Terima kasih kak {name}! 🎉 Silakan transfer ke:\n🏦 {bank_name}: {bank_account_number}\n👤 a.n. {bank_account_name}\n💰 Nominal: Rp {total}\n\nSetelah transfer, mohon kirim bukti pembayaran ya kak."

## Confidentiality (critical)
- Never mention subcontractors or external kitchens
- Always say "dapur kami" — implies internal
- Never reveal margins, COGS, or operations

## Escalation
Call escalate_to_human when:
- Customer complains about food quality or asks for refund
- Customer uses any of these keywords: {escalation_keywords}
- Customer seems frustrated after repeated confusion
- Any request outside routine ordering or FAQ

## Honest about AI
If asked "apakah ini bot?": "Iya kak, saya AI assistant {business_name}. Tapi tenang, Kak Annie selalu standby untuk hal-hal yang butuh bantuan langsung."

## Minors
If customer is under 18, ask for parent or guardian involvement before proceeding.

## Anti-abuse
- Never produce repetitive content or lists of 100+ items
- Maximum 200 words per reply
- Refuse requests designed to waste tokens

## Annie's custom instructions
{custom_instructions}

## Current context
- Customer state: {customer_state}
- Customer name (if known): {customer_name}
- Today: {current_date}
- Order deadline tonight: {deadline}
```

`{mode_instruction}` is either:
- Polished (50%): "Use polished Indonesian with proper punctuation and appropriate emojis."
- Casual (50%, conversational messages only): "Use casual lowercase Indonesian, no punctuation, no emojis, like a friend texting quickly. Never use casual mode for order summaries, bank details, or payment amounts."

## Settings cache

In `src/lib/cache/settings.ts`, implement an in-memory cache:

- Load all settings + pricing tiers + message templates on server startup
- Refresh every 60 seconds in the background
- Expose typed getter functions: `getSetting(key)`, `getPricingTier(portions)`, `getTemplate(key)`
- The webhook reads from cache on every message — never queries DB per message for settings

## Safety implementations

### Rate limit check

```ts
async function checkRateLimit(customerId: string): Promise<{ allowed: boolean; reason?: string }> {
  const row = await getOrCreateRateLimitRow(customerId);
  const today = new Date().toDateString();
  const lastReset = new Date(row.last_reset_at).toDateString();

  if (today !== lastReset) {
    await resetDailyCounters(customerId);
    return { allowed: true };
  }

  if (row.daily_message_count >= 20) return { allowed: false, reason: 'daily_limit' };
  if (row.minute_message_count >= 5) return { allowed: false, reason: 'minute_limit' };
  if (row.daily_token_count >= 100000) return { allowed: false, reason: 'token_limit' };

  await incrementCounters(customerId);
  return { allowed: true };
}
```

### Circuit breaker

In-memory module-level state in `src/lib/claude/safety.ts`:

```ts
const breaker = {
  failures: 0,
  lastFailure: 0,
  openUntil: 0,
};

// Before Claude call:
if (Date.now() < breaker.openUntil) throw new Error('Circuit open');

// On success: breaker.failures = 0;
// On failure:
breaker.failures++;
breaker.lastFailure = Date.now();
if (breaker.failures >= 5 && Date.now() - breaker.lastFailure < 60000) {
  breaker.openUntil = Date.now() + 5 * 60 * 1000; // 5 minutes
  sendPushToAllAdmins('Claude circuit breaker open', 'Too many API errors', '/settings', 'high');
}
```

### Echo detection

Before sending reply, load last assistant message from `conversations`. If `newReply === lastAssistantMessage`, log warning, push notify Annie, abort — do not send.

### Prompt injection detection

Before Claude call, check message content:

```ts
const injectionPatterns = [
  /repeat.{0,20}\d{3,}/i,
  /x\s*\d{4,}/i,
  /ignore (previous|all|your) instructions/i,
  /forget your/i,
  /\[system\]/i,
];
const isInjection = injectionPatterns.some(p => p.test(message)) || message.length > 2000;
```

If detected: send generic template, set `is_suspicious = true`, skip Claude.

## Dashboard pages

### `/login`

Magic link email login via Supabase Auth. Validate that email exists in `admin_users` table on the server before sending the link. Redirect to `/` on success.

### `/` (home)

Stat cards loaded in parallel with `Promise.all`:
- Active customers today (orders with status `active`)
- Deliveries scheduled today
- Pending payment count (status `pending_payment` or `payment_proof_received`)
- Today's revenue (sum of `total_price` for orders paid today)

Kill switch toggle — reads `chatbot_enabled` from settings. On toggle, updates DB and clears settings cache. Shows confirmation modal before disabling.

Push notification subscription button — only shown if browser permission not yet granted.

Skeleton loaders for all stat cards during load.

### `/inbox`

Real-time via Supabase Realtime subscriptions on `conversations` table.

- Conversation list: sorted by most recent message, shows customer name + last 4 digits + last message preview + unread indicator
- Conversation detail: full message thread with timestamps, model badge (`S` for Sonnet, `H` for Haiku)
- "Take over" button: sets `escalated_to_human = true`, bot stops responding
- "Resume bot" button: clears flag, bot resumes
- Manual reply input + send button: uses WhatsApp API to send from Pian Yi number, saves to `conversations` as `role: assistant`, `model_used: 'human'`

### `/customers`

Paginated list (20/page) with TanStack Query.

Search: debounced input filtering by name or phone number.

Columns: name, phone (last 4 digits only), area, state badge, last order date.

Detail view (slide-over or separate page):
- Full customer info
- Editable fields: name, address, area (allowlist — no other fields editable)
- Order history list
- Link to conversation thread
- Flags display (suspicious, blacklisted, etc.)

Optimistic updates on save.

### `/payments`

Three tabs using TanStack Query:

**Pending verification** — orders with status `payment_proof_received`:
- Customer name + phone
- Order summary (package size, total)
- Payment proof image (inline viewer)
- "Mark as paid" button → sets status to `active`, `paid_at = now()`, sends WhatsApp confirmation to customer, push notifies both admins
- "Reject" button → text input for reason, sets status back to `pending_payment`, sends WhatsApp message to customer

**Awaiting payment** — orders with status `pending_payment`, sorted by `confirmed_at`:
- Shows time elapsed since confirmation
- Color coding: green < 1h, yellow 1-4h, red > 4h

**Paid today** — orders with `paid_at` today, read-only view.

Optimistic updates on "Mark as paid".

### `/settings`

Read-only display for Phase 1. Render all `settings`, `pricing_tiers`, and `message_templates` rows in organized sections. Each row shows key, current value, and description. No edit forms yet.

## Cron jobs

All endpoints protected by checking `Authorization: Bearer {CRON_SECRET}` header.

### `/api/cron/send-reminders`

Query all `pending_payment` orders where `confirmed_at < now() - unpaid_reminder_hours` and a reminder hasn't been sent yet. Send `payment_reminder_gentle` template via WhatsApp. Mark reminder sent (add `reminder_sent_at` column to orders table).

### `/api/cron/cancel-unpaid`

Query all `pending_payment` orders where `confirmed_at < now() - unpaid_cancel_hours`. Update status to `cancelled_unpaid`, set `cancelled_at = now()`. Send `payment_overdue_final` template to customer. Push notify Annie.

### `/api/cron/daily-summary`

Run at 9am WIB (UTC+7, so 02:00 UTC). Aggregate yesterday's metrics: orders created, orders paid, revenue, new customers. Send push notification digest to all admins.

Configure all three in Railway's cron scheduler.

## Push notifications

Generate VAPID keys (one-time, save to env):
```bash
node -e "const wp = require('web-push'); console.log(wp.generateVAPIDKeys())"
```

`src/lib/push/send.ts` exports:

```ts
export async function sendPushToAllAdmins(
  title: string,
  body: string,
  url: string,
  priority: 'high' | 'medium' | 'low'
): Promise<void>
```

Loads all `push_subscriptions` from DB, calls `webpush.sendNotification()` for each. Handles expired subscriptions by deleting them from DB.

Frontend service worker: `public/sw.js` handles `push` events and shows notifications. Links to the `url` field on click.

Install prompt on home page: shows "Enable notifications" button. On iOS, shows instructions: "To enable push notifications, tap the Share button and select 'Add to Home Screen' first."

## GitHub setup

```bash
gh repo create pian-yi --private --source=. --remote=origin --push
gh secret set ANTHROPIC_API_KEY
gh secret set WHATSAPP_TOKEN
gh secret set WHATSAPP_APP_SECRET
gh secret set SUPABASE_SERVICE_ROLE_KEY
gh secret set CRON_SECRET
gh secret set VAPID_PRIVATE_KEY
```

## Railway deployment

Create `railway.json` in project root:

```json
{
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "node .next/standalone/server.js",
    "healthcheckPath": "/api/health",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

`next.config.ts` must have `output: 'standalone'`.

Create a health check endpoint at `/api/health/route.ts`:

```ts
export function GET() {
  return Response.json({ ok: true, service: 'pian-yi', ts: Date.now() });
}
```

Cron configuration in Railway dashboard:
- `POST /api/cron/send-reminders` — every hour
- `POST /api/cron/cancel-unpaid` — every hour
- `POST /api/cron/daily-summary` — `0 2 * * *` (9am WIB = 2am UTC)

Add this to `README.md` as deployment instructions.

## Deliverables checklist

- [ ] Missing scripts added to `package.json` (`typecheck`, `db:types`, `db:reset`, `db:push`)
- [ ] All dependencies installed via pnpm
- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm lint` passes with zero errors
- [ ] Supabase CLI initialized and linked
- [ ] All database migrations under `supabase/migrations/`
- [ ] Seed data in `supabase/seed.sql`
- [ ] All RLS policies in migrations
- [ ] `src/types/database.ts` generated via `pnpm db:types`
- [ ] Settings cache implemented with 60s TTL
- [ ] Auth (magic link, admin_users gating) working
- [ ] Webhook: signature verification, idempotency, async processing
- [ ] Haiku 4.5 classification integrated
- [ ] Sonnet 4.6 chatbot with all tools, rate limits, circuit breaker, echo detection
- [ ] All 4 dashboard pages functional
- [ ] Settings page (read-only)
- [ ] Kill switch working
- [ ] Push notifications working (Android + iOS PWA install flow)
- [ ] 3 cron endpoints implemented with `CRON_SECRET` protection
- [ ] Health check endpoint at `/api/health`
- [ ] `railway.json` created
- [ ] `.env.example` complete
- [ ] GitHub repo created via `gh`, secrets set
- [ ] `README.md` with setup + deployment instructions using pnpm + Supabase CLI + Railway

## Build order

Work in this order and write a short status note after each milestone:

1. Add missing scripts, install dependencies, run `pnpm typecheck` to confirm baseline
2. Supabase: migrations → RLS → seed → generate types
3. Auth: login page, callback, admin_users check, protected layout
4. Settings cache: load from DB, 60s refresh, typed getters
5. Webhook: GET verification, POST structure, signature check, idempotency, async processing skeleton
6. Claude integration: Haiku classifier, Sonnet chatbot, tools, rate limits, circuit breaker, echo detection
7. WhatsApp sending: typing indicator, delay, message send
8. Dashboard home page
9. Inbox page with Supabase Realtime
10. Customers page
11. Payments page
12. Settings read-only page
13. Push notifications: VAPID, subscription endpoint, service worker, home page prompt
14. Cron endpoints
15. Health check + `railway.json`
16. GitHub repo + secrets via `gh`
17. Final: `pnpm typecheck` + `pnpm lint` — zero errors required before marking done
