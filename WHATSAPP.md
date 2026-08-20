# WhatsApp — window, delivery, webhook

Read this before changing outbound sends, the webhook route, or anything that depends on a message actually reaching a customer.

The 24-hour window and the WABA payment restriction are the two things most likely to make a correct-looking send vanish silently.

## The 24-hour WhatsApp window is told to the customer, not hidden

Meta blocks a business from writing first once 24 hours have passed since the customer's last inbound message, and nothing we send reopens it — only they can. Customers do not know this, so our enforced silence reads as being ignored. On 2026-08-18 Jordy, whose delivery had been missed, wrote "Saya gk mau tau, masa harus saya yang follow up tiap hari??" and threatened a refund; he had no way to know we were locked out of his thread.

Both wordings live in `src/lib/whatsapp/window-notice.ts` and both end on the same explicit ask — *if it has been over 24 hours, message us first*:

- `WINDOW_NOTICE_WELCOME` — its own bubble, sent last in the welcome sequence, after the T&C.
- `WINDOW_NOTICE_SHORT` — appended to the payment-request message (`createOrderFromExtraction`), both `mark_paid` confirmations (`PATCH /api/orders`, assistant `mark_order_paid`), both renewal reminders (`renewal-reminders` cron), the gentle payment reminder (`send-reminders`) and the overdue notice (`cancel-unpaid`). Every one of those is a moment the customer has no reason to write again for days — which is exactly how a window closes unnoticed — and each fires at most once per order, so it never becomes wallpaper.
- `WINDOW_NOTICE_CLAUSE` — one clause on the daily delivery-proof "balas *ok*" (`photo-matcher.ts`). That message already asked for the reply; it never said why, so a customer who skipped it had no idea it was what kept us reachable. It goes out every delivery, so it gets a clause and not the paragraph.

Deliberately **not** added to: the re-engagement crons (`lapsed-customers`, `abandoned-recovery`, `refresh-wa-window` — their entire job is already to elicit a reply, and `refresh-wa-window` explains the rule in its own words), the post-delivery feedback ping (a casual one-liner that fires on ~20% of deliveries), broadcasts (admin writes the copy), and anything a human typed through the inbox or Assistant.

- `WINDOW_NOTICE_TEMPLATE` (`jendela_24_jam`) — the same notice as an **approved Meta template**, which is the only thing that reaches a customer whose window is already shut. Body takes one param (the customer's name), footer "Pian Yi Catering", one quick-reply button ("Halo, mau tanya") — tapping it is an inbound message, so the button itself reopens the window. Submitted 2026-08-18 to WABA `1603294840784079`, template id `1776416490076084`, category UTILITY, language `id`. Sent via `sendTextTemplate()` (`src/lib/whatsapp/client.ts`); its only caller is the `refresh-wa-window` cron, as a fallback when the free-form send comes back 131047 because the window lapsed between the query and the send. The WABA id is not in the env — it is `entry[0].id` on any `webhook_events` payload.

The welcome sequence only ever fires once per phone number, so it does nothing for existing customers — the order-confirmation copies are what reach them, at their next purchase. Both strings are hardcoded, matching the T&C block they sit beside; if either moves to `settings`, move both.

## No payment method on the WABA — every template send fails

An approved template is what Meta lets you send outside the 24h window, and ours is fine. The account is not: **no payment method is attached to the WABA**, and template messages have been paid per send since Nov 2025. Meta accepts the API call, returns a wamid — so our row optimistically reads "sent" — and fails the delivery afterwards with:

> `131042` Business eligibility payment issue — *"Message failed to send because no payment method is set up for your WhatsApp Business account."*
> Fix at `business.facebook.com/billing_hub` → business `1304799927697056`, asset `1603294840784079`.

Confirmed 2026-08-18 by `scripts/probe-template-window.ts`, which sends a template to a customer silent for weeks and reads the receipt back off `conversations.whatsapp_error`. Run it any time this is in doubt.

**Adding a card did not clear it.** A debit card was attached that afternoon and the error text changed — from "no payment method is set up" to **"your WhatsApp Business account payment has been restricted"** — but the code is still `131042` and every send still fails. Ten probes over 24 minutes (14:28–14:52) all failed identically, so this is not propagation delay: the account carries a restriction of its own, most likely an unpaid balance from the earlier declined card, and it has to be cleared by hand in the billing hub. `health_status` still reports only `141010` throughout, so it is no help in telling these two states apart — the probe is.

The effect was total and invisible for two months. Every delivery-proof send since 20 Juni splits perfectly on the window: **219 sent inside it were delivered or read, and all 296 sent outside it failed** — no overlap in either direction. Meta's Template Insights only counts what got delivered (192 sent / 192 delivered / 0 failed, `Amount spent: —`), so nothing on Meta's side shows a problem. The inbox was the only place the failures appeared, as a red "Failed" with no reason attached.

Two further account limits are real but were **not** the cause here: business verification has never been submitted (`141010`, `verification_status: pending_submission`, so `health_status.can_send_message: LIMITED`), and the display name is unapproved, holding the number at `TIER_250`. Both need doing; neither is what 131042 is complaining about.

`conversations.whatsapp_error` (jsonb, migration 069) now stores Meta's `errors[]` from the status webhook, written by `updateMessageReceipt`, and the inbox prints it next to "Failed". `parseStatusUpdates` prefers `error_data.details` over `message` — the latter usually just repeats the title, while details carries the actionable sentence and the billing link. Before this the code only reached `console.error`, which is why nothing from Juni survived to diagnose.

Until a card is on file, **every business-initiated send is a dead letter** — delivery proofs, `jendela_24_jam`, and the `refresh-wa-window` template fallback all fail in exactly the case they exist for. `jendela_24_jam` was also auto-recategorized by Meta from UTILITY to MARKETING, which makes it billable at the higher rate and subject to marketing limits once billing works.

## Idempotency strategy

- Every incoming WhatsApp `message_id` is checked against `processed_messages` table before processing
- A `select` pre-check is a cheap fast-path, not the guard — Meta redelivers events within milliseconds and two concurrent requests can both pass the `select` before either write lands
- The real atomic guard is the `insert` itself (`message_id` is the table's primary key): its error must always be checked and treated as "another request already claimed this message_id" before proceeding to call Sonnet or send a reply
- **The webhook returns 200 *after* landing the raw payload in `webhook_events` (migration 067), not before.** The 200-then-process shape is still right — Meta's timeout is short and processing calls the model — but it meant a database outage ate customer messages in total silence: the 200 was already sent, so Meta never retried, and nothing anywhere recorded that the message had arrived. On 2026-08-18 Supabase's REST layer wedged for 15 minutes (Postgres itself was healthy; PostgREST was not) and only an empty inbox that morning kept it from costing real messages. The route now writes the payload first and returns **503** if that write fails, which is what makes Meta retry — the redelivery is harmless because `processed_messages` still guards it. Only inbound messages get this treatment; `statuses[]` receipts are re-sent constantly by Meta and blocking on a write for them would add latency to the noisiest half of the traffic to protect nothing. Processing outcome is written back to the row (`processed_at`, or `error`), so `select * from webhook_events where processed_at is null` is the list of deliveries that arrived and never finished.
