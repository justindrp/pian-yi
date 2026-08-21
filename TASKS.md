# Open tasks

Everything outstanding as of **2026-08-20**, so a fresh session can pick up without reading back through chat history. Ordered by when it bites, not by size.

Rules that apply to all of it live in `CLAUDE.md` and the topical docs it maps (`BOT_RULES.md`, `OPERATIONS.md`, `WHATSAPP.md`, `ADMIN.md`); this file is the queue, not the reference. When an item is finished, delete it here and fold anything durable into whichever doc owns that subject.

---

## 1. Live this week — dated, will go wrong on its own

### ICE BSD / INDO5 event, 21–23 Agustus (Jumat–Minggu)

Paid in full, Rp 3.600.000, 180 porsi. Customer `fe29dd04-05a0-4c8d-8774-b69b4ace1fe5` ("Ade Dian (INDO5) - event ICE BSD", `+6281299263995`), order `96f90894-002b-41ab-9772-9332627002e6`, 9 `daily_deliveries` rows.

| Slot | Jumat 21 | Sabtu 22 | Minggu 23 | Kitchen |
|---|---|---|---|---|
| breakfast | 07.00 | 08.00 | 08.00 | Dapur Mama Echa `2ddacfe5-8224-4378-a587-c053a3622d1b` |
| lunch | 11.00 | 11.00 | 11.00 | Molls Kitchen `ca6f3ac1-226c-4e3f-a610-fb54f84c4717` |
| dinner | 18.00 | 18.00 | 18.00 | Molls Kitchen |

20 porsi per slot. Both kitchens quote Rp 15.000/porsi → COGS Rp 2.700.000, margin Rp 900.000.

Drop point: **Lobby Hall 7, booth Mastercard** (booth hitam, signage "LIVE YOUR MOTION"). PIC **Rifqi 0895-2586-6150** / **Elle 0896-9678-4101**.

Still open:

- **Confirm the kitchens have the PIC number and the booth detail.** We told the customer "kurir kami akan menghubungi kak Rifqi sesaat sebelum tiba" — both kitchens deliver themselves, so that promise is theirs to keep. Justin said his admin is briefing them; nobody has verified the PIC number made it into the briefing.
- **The WhatsApp thread is no longer watched.** A `Monitor` was tailing it this session and dies when the session ends. During the event, someone has to watch the inbox by hand.
- **Out-of-window sends will fail all weekend.** His last inbound was 2026-08-20 07:49 UTC, so free-form works until 2026-08-21 14:49 WIB — that covers Jumat 07.00 and nothing after. If he goes quiet, the `jendela_24_jam` template fallback still fails on `131042` (see §2). The only reliable channel to his side on Sabtu/Minggu is calling the PIC phones directly, not WhatsApp from our number.
- Journals post when the daily sheet is worked; rates were set before the first delivery, so no retroactive correction is due.

### Daevin's trial ends 23 Agustus

7-day work trial 17–23 Agustus, `admin` role, not hired. On the 23rd it's either an offer or a revoke. A revoke is now **one delete** — `admin_users` — since push sends filter on that table (`src/lib/push/send.ts`). His `edit_log` rows stay; that table is append-only.

---

## 2. Blocked on Justin — account and money, not code

- **WABA payment restriction `131042`.** Every business-initiated send is a dead letter: delivery proofs outside the window, `jendela_24_jam`, the `refresh-wa-window` fallback. A debit card was attached 2026-08-18 and the error only changed wording ("no payment method is set up" → "payment has been restricted"), so there is a restriction on the account itself, most likely an unpaid balance from a declined card. Clear it by hand: `business.facebook.com/billing_hub` → business `1304799927697056`, asset `1603294840784079`. Re-probe with `scripts/probe-template-window.ts`, which reads the receipt back off `conversations.whatsapp_error`.
- **Business verification never submitted** (`141010`, `verification_status: pending_submission`) → `health_status.can_send_message: LIMITED`.
- **Display name unapproved** → the number is stuck at `TIER_250`.
- **Free-quota orders for the overdrawn customers** (`OVERDRAW.md`, 32 customers / 178 portions). The customers overdrawn by only 1–2 portions are the missing balance guard, not deliberate free quota; the interpretation of each case is in `OVERDRAW.md`. Pending Justin's per-customer verification of what was actually granted — do not create them speculatively.

---

## 3. Correctness bugs, unfixed

- **A stated day pattern is thrown away.** "weekdays only", "tiap jumat libur" is read by the model, restated to the customer, then lost — nothing on `orders` records which weekdays a package runs on. Generation fills Senin–Sabtu minus closures. Durable fix is a per-order weekday mask; until then a stated pattern has to be corrected by hand after payment. Two customers already hit it (Sherine Fayola, Lina Marlianty), repaired by `scripts/fix-sheet-audit-0820.ts`.
- **`linked_order_id` is honoured in one draw path out of four.** Only `addable-customers` (`src/app/api/deliveries/addable-customers/route.ts:65`) consults it. The daily-sheet POST, `bulk-create` and the `generate-deliveries` cron call `pickDrawOrder()` on the customer's own orders, so a linked customer charges their own (usually `pkg=0`) order. Only Darren Dior is linked today and he has not ordered since March — any new linked customer needs the other three fixed first.
- **A size reduced after a schedule exists leaves the surplus days.** `resizePendingOrderFromMessage` (`src/lib/claude/extract-order.ts:800`) shrinks the package but calls `fillMissingSchedule`, which only ever touches an order with zero delivery rows. Nothing has hit it yet.
- **No draw path checks the balance before writing**, so a fully-used order still goes negative. A hard reject in the daily-sheet `PUT` is unblocked for the reconciled set, but 72 customers hold a `package_size = 0` import artifact and must be backfilled first or the guard rejects their legitimate deliveries.
- **Renewal reminders miss anyone who skips the threshold.** `src/app/api/cron/renewal-reminders/route.ts:34,58` use `.eq("portions_remaining", threshold)` — a customer drawing 2 portions in a day steps over the value and is never reminded. Should be `<=` plus the already-sent guard.
- **`GET /api/customers?all=true` has a latent 1000-row cap.** `src/app/api/customers/route.ts:25` — plain `.select()` with no `.range()` loop. Harmless at 336 customers, silently wrong above 1000. Fix with `fetchAllRows()` from `src/lib/supabase/fetch-all.ts`. Architectural principle 9.
- **`/api/auth/check-admin` has no session verification** — allows unauthenticated admin email enumeration. Extract the email from the verified Supabase session instead.
- **No outbound scrubbing guard on subcontractor names.** The prompt forbids repeating a supplier name back and the model does it anyway, writing a real kitchen name straight into a reply. Prompt text is not enforcement; a scrub on outbound replies — built from the live `subcontractors.name` values, not a list — is the durable fix.
- **A delivery proof is never linked to the delivery it proves.** `delivery_proofs.matched_delivery_id` is null on **566 of 566** rows and `daily_deliveries.delivery_proof_id` on **2833 of 2833** — the manual send path (Inbox → send delivery photo) writes the proof row and the storage object but never the join, so both columns are dead weight and no delivery can show its own photo. `whatsapp_message_id` is null on all 566 too, so no proof has a send receipt and none can be matched to a `messages` status callback. Ade Dian's 2026-08-21 breakfast proof (`7dd9f8c7`) is the current example. The customer-facing send works; it is the record that is missing.

- **A new delivery area is orderable but unrouteable.** Coverage now comes from the database everywhere (2026-08-21), but everything *derived* from an area is still a literal keyed on five specific names: `getDeliveryRoute()` (`src/lib/utils/format.ts:1`) returns `null` for anything else, the Route 1/Route 2 labels in `deliveries-client.tsx:115` name the same areas, and the BSD Baru/BSD Lama split at `src/app/api/webhook/whatsapp/route.ts:421` is a longitude comparison. Add an area to a kitchen today and it appears in every dropdown and in the bot's served list, then lands on the daily sheet with no route. Durable fix is a `route` (and maybe a bounding box) per area — most naturally a column on a real `areas` table, which does not exist yet: areas are currently just strings inside `subcontractors.delivery_areas`.
- **`scripts/import-customers-orders.ts` still holds two literal area lists** (`:34` abbreviation map, `:671` route split). Left alone deliberately — it maps one historical spreadsheet and rerunning it should reproduce what it produced then. Do not "fix" it; delete it when the import is provably never needed again.
- **Agnes's Supabase Auth identity still exists.** She fails the `admin_users` allowlist so she cannot use the dashboard, and her push devices are now filtered out — but the auth user was never deleted.
- **Annie has no push subscription registered.** She is an `owner` and receives no push notifications on any device. Pre-existing, not caused by the recipient filter; she needs to subscribe from her own browser.
- **`supabase/seed.sql`** may still reference the old `"BSD"` area string, never split into BSD Baru / BSD Lama.

---

## 4. Calendar tasks

- **Extend `src/lib/holidays/id.ts` past `HOLIDAYS_KNOWN_THROUGH` (`2026-12-31`, line 105).** The 2027 SKB 3 Menteri is normally published around September 2026. Past that date `describeUpcomingHolidays()` returns null and the prompt escalates rather than claiming no holidays are coming — safe, but a whole year of dates silently missing is a real operational risk. Most of the list is not derivable (lunar and Easter-linked dates, plus cuti bersama set by decree).

---

## 5. Bot quality

- **Relaunch the replay harness, round 15.** `./scripts/replay-guard.sh 90` — never `pnpm tsx scripts/replay-orders.ts` directly, which has no stop at all. The guard kills the process group on a wall-clock deadline or when the five-hour rate limit reaches `REPLAY_KILL_AT_PCT` (default 90), read from `/tmp/claude-rate-limit-pct`, which is written by the statusline hook outside this repo.
- Treat a prompt change as a business-rule decision needing a reason beyond "the replay went green". Tuning `system.ts` until 20 transcripts pass teaches the bot those conversations, not ordering.

---

## 6. Deferred features (designed, not started)

- **Delivery proof auto-send.** Call `sendDeliveryPhotoToCustomer(proofId, customerId)` directly in the POST route instead of the current "Ready to send" UI step.
- **Accounting Phase 4** — "Balik jurnal" reverse-entry action: post a mirror entry (swap debit/credit), link via `reversed_journal_id` on `journals`. `source_type: "manual"` only; auto-posted entries stay locked.
- **Accounting Phase 5** — CSV export for journals/ledger (`?export=true`) and a quick-expense form that builds a 2-line balanced journal from account + amount.
- **Instagram daily post generator** (designed 2026-08-16, never started). One auto-generated post per day. Shape: `instagram_posts` table keyed `scheduled_for date UNIQUE` (that index is the idempotency guard), two jobs in the existing in-app scheduler (generate ~07:00 for tomorrow, publish ~11:00 today, both `catchUp: true` same-day), a public `instagram-media` bucket because Meta fetches the image by URL, and an `/instagram` review page. Store `ig_creation_id` between the two Graph calls — a retry after a partial failure must resume at publish or it double-posts. **The long pole is not code:** the Content Publishing API needs `instagram_content_publish` + `instagram_basic` through Meta App Review, and a Business/Creator IG account linked to a Facebook Page. Reuse the existing WhatsApp Meta app (already business-verified) and a Business Manager **System User** token, which does not expire. Open questions when resumed: AI-generated food imagery vs AI backgrounds behind real photos (the food we sell should not be a picture of food that never existed, and Meta labels AI images), auto-publish vs approve-first, and which image vendor.
- **Domain naming refactor** (big). `order` means the prepaid package everywhere and the daily portion-draw has no name. Preferred fix: add `drawdown` as the daily-draw layer, leave every existing `order` reference alone. The alternative (rename package → `package_order`, draw → `order`) has a blast radius across tables, routes, tools, chat and accounting descriptions.
- **Drop `customers.portions_remaining` and `customers.avg_price_per_portion`.** Dead columns, still written by six paths, read by none. Gated on the reconciliation chain: 27 customers hold a cached balance with no order behind it (Michelle Nathania's 30 portions the largest) and deriving turns those to 0.

---

## 7. Open questions

- **Rename `WINDOW_NOTICE_SHORT`?** The four exports in `src/lib/whatsapp/window-notice.ts` are named inconsistently — `WELCOME` and `CLAUSE` describe placement, `SHORT` describes size and implies a `LONG` that does not exist. `WINDOW_NOTICE_ORDER` or `_TRANSACTIONAL` would match. Six call sites plus the export. Asked, not answered.
