# Open tasks

Everything outstanding as of **2026-08-24**, so a fresh session can pick up without reading back through chat history. Ordered by when it bites, not by size.

Rules that apply to all of it live in `CLAUDE.md` and the topical docs it maps (`BOT_RULES.md`, `OPERATIONS.md`, `WHATSAPP.md`, `ADMIN.md`); this file is the queue, not the reference. When an item is finished, delete it here and fold anything durable into whichever doc owns that subject.

---

## 1. Live this week — dated, will go wrong on its own

### DeepSeek balance hit zero — the bot was silent for two hours this morning

`GET https://api.deepseek.com/user/balance` returned `-0.01` at 2026-08-24 10:26 WIB. Every model call since **08:28 WIB** answered `402 Insufficient Balance`. Top up at platform.deepseek.com and it resumes with no deploy.

What that outage looks like from the inside, because it will happen again:

- The catch at `src/app/api/webhook/whatsapp/route.ts:1645` sends the `chatbot_unavailable` template and **writes no `conversations` row**, so the inbox shows the customer waiting with nothing beside it. There is no way to tell "the bot is broken" from "nobody answered".
- The only alarm is a push, and push had been dead on Justin's iPhone since 21 Agustus.
- Left unanswered while it was down: **Julian S** (3 messages, from 09:33), **Veronica Catherine** (3, from 09:55), **Ade Dian / ICE BSD** (1, 10:12), and a lead asking "bisa catering 3 lauk tanpa nasi?" at 08:53. All answered by hand on 2026-08-24 — Julian by Justin at 11:02, the other three at 14:4x through the owner-only manual path. Veronica needed nothing (her messages were closings; her Senin 24 dinner was on the calendar). Nothing recovers these on its own: the model never sees a turn it failed to answer, so a topped-up balance does not make the bot go back for them.

### Selasa 25 Agustus — we told three customers we were closed, and we are open

`OPEN_DESPITE_HOLIDAY` in `src/lib/holidays/id.ts:130` carries `2026-08-25`, added on 23 Agustus after Maulid Nabi cost Veronica Catherine a delivery day Thenie was open for. The customers we spoke to before that still have the old answer:

- **Tio Jason** `+62859106965430` — 18 Agustus, hand-typed: "dapur partner kami belum pasti buka hari itu… kemungkinan libur". Hedged, and the bot backed it up. Calendar skips 25; `rem = 4`.
- **Tiwi** `+6287808781094` — 18 Agustus, hand-typed: "Selasa 25 Agustus tanggal merah (Maulid Nabi), kami libur, jadi totalnya 7 hari". Flat, no hedge, **and her 6-porsi package was sized on it**. Calendar skips 25; `rem = 2`.
- `+6281213330779` — 22 Agustus, bot: "kami tutup hari itu". Never ordered, so no exposure.

The reverse on the same date: **Julian S** was promised dinner on Senin 24 *and* Selasa 25 (bot, 19 Agustus, "2 hari dinner… masih cukup dari sisa 3"). Generation dropped his 25th as a holiday before the override landed, so his rows are 24, 26, 27 and he is owed that meal with `rem = 2`.

**The prompt half is fixed** (`46f7ebb`): `describeUpcomingHolidays()` rendered its lines off `holiday.type` and ignored `OPEN_DESPITE_HOLIDAY`, so the model was still told 25 Agustus was `TUTUP` while generation booked it. At 16:46 WIB on 24 Agustus **Veronica Catherine** asked to add lunch to her Selasa 25 delivery and was told "kami tutup dan nggak ada pengiriman hari itu" — with her dinner row for that date already on Thenie's sheet. **Settled 24 Agu 17:0x WIB:** she had asked to make Selasa 25 lunch *and* dinner; the lunch row was inserted by hand against order `476440a1` (`rem` 1 → 0, logged to `edit_log` as `manual_create`) and she was sent an apology confirming both meals run tomorrow. The date now renders `BUKA` and the prompt says to treat it as an ordinary working day.

The data half is not fixed, and mostly should not be: every schedule generated before 23 Agustus skips the 25th and pushes the day to the end of the calendar, so no portions are lost. Audited on 24 Agustus — **tomorrow's sheet holds 2 rows / 3 portions (Thenie only)** while these standing schedules jump 24 → 26: Tiwi (l1), Sherine Fayola (l1+d1), Lina Marlianty (l1), Nadya (l1), and Veronica's new 6-porsi order `a4bef23a` (starts 26 despite `start_date` 2026-08-24). Veronica's own 25 Agustus lunch has since been added by hand, so tomorrow's sheet is 3 rows / 4 portions. Nothing is on the sheet that should not be. Decide whether to tell Tio and Tiwi the 25th is on before doing anything to their rows.

**Rows recovered 24 Agu 17:2x WIB** (Thenie takes additions until 18:00 — see "Order deadline" in `OPERATIONS.md`). Sherine Fayola (l+d), Lina Marlianty (l), Nadya (l) and **Tio Jason** (l) were each given their 25 Agustus row by hand, drawn from their own order and logged as `manual_create`. None of the three women had ever been told the 25th was closed — their rows were simply generated under the old rule — so no message was needed. **Tio Jason was told "kemungkinan libur" on 18 Agustus and his window is closed**, so food will arrive tomorrow that he was told probably would not. He cannot be reached on the WABA until he writes first — send it from the manual number `+62 851-2802-4390` instead (see "The manual number" in `WHATSAPP.md`). **Lina Marlianty and Nadya both skipped tomorrow** — each told Justin on that number after her row had been booked, so both rows were deleted again. Lina's quota was returned (`rem` 7 → 8); Nadya's was not, because her row had been an over-draw in the first place (`quota_deducted: false`, 21 rows booked against a 20-porsi package, `rem` already 0 at insert), so returning a portion would have invented one. Tomorrow's sheet is now **6 rows / 7 porsi**, all Thenie.

Separately, six `active` fixed-schedule orders have quota left and **no delivery row on or after 25 Agustus at all** — their schedules simply stopped: Sky `+6282259667519` (20 of 20 left, *never generated a single row*), Fahmi (15, last 11 Agu — see below), Vania `+6281292339008` (10, last 21 Agu), Maria Marcella `+6285213668068` (1, none), Fiana Agistha `+6281299038706` (1, last 4 Agu), Nicholas Satria `+628561700441` (1, last 15 Agu). Sky is the one that costs money today: paid for 20 portions, booked for none.

### ICE BSD / INDO5 event, 21–23 Agustus — **finished; the sheet still does not know it**

Paid in full, Rp 3.600.000, 180 porsi. Customer `fe29dd04-05a0-4c8d-8774-b69b4ace1fe5` ("Ade Dian (INDO5) - event ICE BSD", `+6281299263995`), order `96f90894-002b-41ab-9772-9332627002e6`, 9 `daily_deliveries` rows.

| Slot | Jum'at 21 | Sabtu 22 | Minggu 23 | Kitchen |
|---|---|---|---|---|
| breakfast | 07.00 | 08.00 | 08.00 | Dapur Mama Echa `2ddacfe5-8224-4378-a587-c053a3622d1b` |
| lunch | 11.00 | 11.00 | 11.00 | Molls Kitchen `ca6f3ac1-226c-4e3f-a610-fb54f84c4717` |
| dinner | 18.00 | 18.00 | 18.00 | Molls Kitchen |

20 porsi per slot. Both kitchens quote Rp 15.000/porsi → COGS Rp 2.700.000, margin Rp 900.000.

Still open:

- **All 9 rows still read `status: "scheduled"`, including Jum'at 21 — which was delivered.** Proofs for that day went out by hand (breakfast `7dd9f8c7`, the 18:00 dinner sent late with an apology at 19:0x), so the food shipped and the sheet does not know it. Nothing marks the day delivered by itself: **journals post when the daily sheet is worked**, so no revenue or COGS has been posted for this event at all. Work Jum'at's sheet before the numbers are read for anything.
- **Confirm the kitchens have the PIC number and the booth detail.** Drop point: **Lobby Hall 7, booth Mastercard** (booth hitam, signage "LIVE YOUR MOTION"), PIC **Rifqi 0895-2586-6150** / **Elle 0896-9678-4101**. We told the customer "kurir kami akan menghubungi kak Rifqi sesaat sebelum tiba" — both kitchens deliver themselves, so that promise is theirs to keep. Justin said his admin is briefing them; nobody has verified the PIC number made it into the briefing.
- The event closed clean. Ade Dian wrote a thank-you on 2026-08-24 at 10:12 WIB and was answered by hand at 14:4x. Order `96f90894` is `active` with `portions_remaining` 0 — it will not complete until the sheets are worked, because completion runs on what was **delivered**.

### ~~`record_daily_order` drops a booking when the meal label picks the wrong order~~ — fixed

**Vania** `+6281292339008` on 24 Agustus at 12:03–12:05 WIB booked dinner for Rabu 26, Kamis 27 and Jumat 28; the bot confirmed three times ("saya proses dulu ✅") and nothing was written. The handler chose the order to draw from by matching `meal_time_preference` against the requested meal, newest first, then bailed on `if (order.portions_remaining <= 0) return`. Her three active orders were `a2daed64` (pref null), `11b8b86d` (`lunch_only`, **10 portions left**) and `da519fd8` (`per_day_decision`, **0 left**); only `da519fd8` is in the `dinner` preference list, so the handler took the empty order and returned. The identical exchange on 15 Agustus did write rows, because `da519fd8` still had balance then — which is why it looked intermittent. The three rows were booked by hand against `11b8b86d` on 24 Agu 17:2x WIB.

Fixed the same evening: the quota gate and the draw order are both computed from the delivery rows now, and the order is chosen by `pickDrawOrder()` over every active order — a meal-preference match is preferred, never a filter that can exclude the only package with balance. A customer who genuinely has no undated portions left gets a **high**-priority push instead of a silent `return`. See "Quota the bot reads" in `OPERATIONS.md`.

### The bot confirms skips it cannot perform

The customer bot's tool list (`src/app/api/webhook/whatsapp/route.ts:1529-1610`) is `extract_order`, `record_daily_order`, `ask_admin_for_help`, `escalate_to_human`, `mark_payment_proof_received`, `send_menu_image`. **Nothing cancels or moves a delivery row.** `record_daily_order` only inserts. So every "skip sudah saya catat" the model writes is unbacked by any write — the prompt (`system.ts:156`) tells it to confirm a skip when the deadline has not passed, and there is no path from that confirmation to the calendar.

**Tiwi settled 24 Agu 17:0x WIB** — told by hand that the skip lands on Selasa 25, not Rabu 26, so her 26 Agustus lunch stands and no row needed changing. The tool gap below is unfixed.

Live case: **Tiwi** `+6287808781094`, 24 Agustus 16:50 WIB — "Ka besok saya skip 1 hari" / "Di hari rabu aja ka". The bot answered "skip hari Rabu 26 Agustus (makan siang) sudah saya catat". Her 26 Agustus lunch row is still `scheduled`, and the two readings of her message point opposite ways: Justin reads it as skip **besok (25)**, deliver Rabu; the bot read it as skip **Rabu (26)**. She has no row on the 25th either way, so the calendar as it stands matches Justin's reading by accident. Ask her which day she meant — her window is open — before touching the 26 Agustus row.

The fix is a `cancel_delivery` / `skip_delivery` tool, deadline-checked, quota returned to `portions_remaining`, logged through `logEdit`. Until it exists the model must not confirm a skip on its own; it should escalate.

### Fahmi's pause was never applied — he is being cooked for

Order `35093d5c-d2be-42e1-b59d-a0514781eaa9` (Fahmi, `+6281341801449`, 20 porsi, 15 remaining, `dinner_only`) is `active` with **`pause_until` null**. He asked to pause until **2026-08-26**. Both the `generate-deliveries` cron and the daily-sheet builder skip an order only when `pause_until >= targetDate`, so with it null he keeps generating dinners he does not want and drawing quota for them. Set it via the Assistant's pause action (`POST /api/assistant/execute`, which writes `status: "paused"` + `pause_until`) so the change lands with an actor on it.

### Cindi — order awaiting payment, second address still missing

Customer `2f1690c9-e52b-4874-884c-27e70ec05e2a` (`+6281263655316`). Order `1e331e01-c497-4392-84d8-746a344f6d04`: 12 porsi, `pending_payment`, Rp 336.000, first delivery ~1 September, kitchen now set (Dapur 1 `52cd5e62-da09-49c9-939c-2f1246566c40`, assigned by hand 2026-08-22 along with its 12 delivery rows — see `BOT_RULES.md`, "A dapur the model omits").

She wants **dinner to her kost in Karawaci, lunch to UPH**, and has not sent the UPH address yet, so `lunch_address_slot` / `dinner_address_slot` are both `1` and every row books to the kost. The amend path now carries `address_2` / `address_2_meal` (shipped `72f2c7d`), so when she sends it the bot can take it — but nothing prompts her. Ask, or set it by hand on the order before 1 September.

### Vania's week is unbooked

Vania `2ca04f0d-d448-4b79-aa5e-7c5140ee6dd6` (`+6281292339008`) has never been asked which days she wants next week, and her stated lunch-only pattern disagrees with the dinner rows on her order. Two other customers are also named Vania (`Vania Stella` `+6282172469880`, `vania shabrina willi` `+6285339321799`) — match on the number, not the name.

### Daevin's trial ends 23 Agustus — tomorrow

7-day work trial 17–23 Agustus, `admin` role, not hired. On the 23rd it is either an offer or a revoke. A revoke is now **one delete** — `admin_users` — since push sends filter on that table (`src/lib/push/send.ts`). His `edit_log` rows stay; that table is append-only.

---

## 2. Blocked on Justin — account and money, not code

- **WABA payment restriction `131042`.** Every business-initiated send is a dead letter: delivery proofs outside the window, `jendela_24_jam`, the `refresh-wa-window` fallback. A debit card was attached 2026-08-18 and the error only changed wording ("no payment method is set up" → "payment has been restricted"), so there is a restriction on the account itself, most likely an unpaid balance from a declined card. Clear it by hand: `business.facebook.com/billing_hub` → business `1304799927697056`, asset `1603294840784079`. Re-probe with `scripts/probe-template-window.ts`, which reads the receipt back off `conversations.whatsapp_error`. Still failing as of 2026-08-23 01:35 WIB — a `delivery_proof` template to a number with no open window returned HTTP 200 `accepted`, then failed async with the same 131042. **The send endpoint always 200s**; the restriction only ever surfaces in the status webhook, so never read a successful POST as proof the channel works.
- **Business verification never submitted** (`141010`, `verification_status: pending_submission`) → `health_status.can_send_message: LIMITED`. Separate from 131042 — verification is not what blocks sends. Details for the submission form: entity **Pian Yi Catering**, NIB **2307250135661**, registered address in Rawabuntu, Serpong. Website field is `https://pian-yi.up.railway.app/`, which now serves a real landing page carrying that same identity block; it used to redirect to the dashboard login, giving a reviewer nothing to match against the OSS record.
- **Display name unapproved** → the number is stuck at `TIER_250`.
- **Keep a balance on the DeepSeek account, and let the code watch it.** Current burn is ~$0.43/day (~$13/month) and the account runs on $2 top-ups, so it empties every four or five days without warning. Either top up in larger increments or expect another outage. The alarm is a code task (§3); the money is not.
- **Free-quota orders for the overdrawn customers** (`OVERDRAW.md`, 32 customers / 178 portions). The customers overdrawn by only 1–2 portions are the missing balance guard, not deliberate free quota; the interpretation of each case is in `OVERDRAW.md`. Pending Justin's per-customer verification of what was actually granted — do not create them speculatively.

---

## 3. Correctness bugs, unfixed

### Cut the DeepSeek bill — ordered by size of the win

Diagnosis, prices and the arithmetic are in "What the API actually costs" in `DEV_REFERENCE.md`. Cost per message roughly tripled since July while volume rose ~40%; a cache hit costs 1/31 of a miss and we appear to get almost none. Confirm first at platform.deepseek.com → Usage, which splits cache-hit from cache-miss input tokens per day — if hit tokens are near zero, the diagnosis is exact.

1. **Stop the casual coin flip from breaking the cache prefix.** `src/app/api/webhook/whatsapp/route.ts:1414` rolls `Math.random()` per message and the flag renders at `src/lib/claude/prompts/system.ts:322`, the second paragraph — ahead of ~6–7K tokens of business rules, so half of all calls bill the whole prompt at the miss rate. Move the instruction to the end of the prompt **and** derive it from a hash of `customer_id` instead of per message: same variety across customers, stable prefix per customer. Biggest single lever, est. 60–80%.
2. **Move `## Current context` out of the system prompt into the first user turn.** It is already last, so it costs only its own tail today — but any edit above it truncates the cached prefix, and the clock inside it changes every call.
3. **Skip `validateReply()` on replies that cannot hallucinate.** It doubles the call count on "iya kak". Gate on length and on whether the reply asserts anything customer-specific.
4. **Alarm on the balance.** Add `GET https://api.deepseek.com/user/balance` to a daily cron and push below $1. Add a `conversations` row when `chatbot_unavailable` goes out, so an outage is visible in the inbox instead of looking like customers being ignored, and treat `402` as its own case rather than a generic API error.

### A skip past the cutoff is escalated instead of answered

Julian S asked on 2026-08-23 at 18:33 WIB whether tomorrow's delivery could be skipped — two and a half hours past the 16:00 cutoff. `cutoffLine` had already told the model the deadline was **SUDAH LEWAT** and not to accept a skip for tomorrow. It replied "kemungkinan sudah lewat ya kak" and parked the question with an admin instead. Two causes, both fixable in the prompt:

- The never-escalate list at `src/lib/claude/prompts/system.ts:550` covers totals, prices, off-list sizes, package days, area and libur dates — **not** skips, changes or the cutoff. Add them, and make the wording general: anything the system prompt already states is not an escalation.
- `ask_admin_for_help`'s own tool description (`route.ts:1575`) says "Use this by default for uncertainty", and line 554 repeats it. Nothing outranks it, so a question the prompt answers still falls through to the default. Say explicitly that a fact stated in the prompt beats the uncertainty default.

Same shape as "A payment-date question is answered, not escalated" in `BOT_RULES.md` — third time this pattern has cost a customer.

### Julian S's parked question — flag now clear, the age limit is still missing

`customer_flags.pending_bot_response` was true on `4acddf61-76f8-43b4-a20d-e836b49d3c4a` for five days, question: "Julian skip pengiriman Kamis 20 dan Jumat 21, lalu request dinner Senin 24 dan Selasa 25. Kuota tersisa 3/5. Mohon konfirmasi." Nobody ever answered it. That flag injects the "A question is with an admin right now" block (`system.ts:581`) into every turn, which instructs the model to say the matter is still being checked — so his new, unrelated skip question could not be answered either. The flag cleared itself when Justin answered him by hand on 2026-08-24 at 11:02 — the manual-reply route sets `pending_bot_response: false` on every send — so the live symptom is gone and the mechanism is not. **Still to build: an age limit.** A question parked for more than a day or two is not being answered, and going on silencing part of the thread for it makes things worse. Nothing expires the flag but a human happening to type into that one thread. His live order is `eb3179b7` (dinner_only, booked 24, 26, 27 Agustus).

- **`statedBareTotal()` cannot read "kuota", the word the bot itself uses.** `src/lib/claude/extract-order.ts:339` matches only `\d+\s*porsi`. Veronica Catherine wrote "Bole kak saya pesen 10 kuota" and was sold **6** — `rawPackageSize` (`:946`) falls back to the sum of the scheduled days whenever the extraction carries a `delivery_schedule`, and the stated-total guard that exists for exactly this case never fired. The bot's own replies say "kuota" constantly, so it trains customers into a word it cannot parse back. Add the synonym to the regex (and to `statedWeeks`'s neighbours while there), then re-run the replay corpus.
- **`createOrderFromExtraction` re-sends the transfer message every time it is called.** `sendPaymentInfo` defaults to `true` (`:942`) with no guard against having already sent one; the amend block at `:1084` prevents a duplicate *order* (the Sherine Fayola fix) but not a duplicate *payment message*. Veronica got Rp 280.000 at 09:08, before any details were collected, then Rp 174.000 at 09:13, and asked "174 atau 280 yaa kak?". Only the webhook recovery path (`route.ts:868`) passes `false`. Suppress the second send when the open order already has one on the thread. **Still firing on 2026-08-24**, three more times in one morning: Naya got Rp 174.000 and Rp 540.000 back to back at 05:12 UTC — the first is the 6-porsi total, not her friend's 5-porsi Rp 145.000, so she asked "ini jdnya 174rb kak ga 145rb?" and the bot escalated its own arithmetic; and "Saya" (`+6285716119878`) was quoted Rp 1.248.000 at 01:26 UTC one minute before being told we do not deliver to Cipondoh. The message goes out on extraction, before area and totals are settled, which is why the number is so often wrong.
- **`createOrderFromExtraction` writes the order before the conversation has settled, and defaults `start_date` to the earliest deliverable date.** Two live examples on 2026-08-24, both repaired by `scripts/fix-eager-orders-0824.ts` (rollback JSON in the scratchpad). `+6285716119878` said "Saya di Cipondoh, dekat Banjar wijaya" at 01:25 UTC; the order was created at **01:26** — 48 porsi, Rp 1.248.000, kitchen assigned, 24 delivery rows — and the bot told them at **01:27** that we do not deliver to Cipondoh. The order got a kitchen because the extraction had already written `area = "Karawaci"`, so the "only active kitchen covering the area" fallback ran on a value the model invented. Nobody agreed to buy anything. Second: Naya said "mulai tgl 31 Agust", the bot confirmed it back to her twice, and her 20 rows were still booked from 25 Agustus. Both bugs are the same shape as the duplicate transfer message above — the order is created on extraction, before area, dates and totals are settled. **The order must not be written until the area check has passed, and `start_date` must come from the customer's stated date when there is one.**
- **`cancel-unpaid` cannot save you from any of that.** It matches on `confirmed_at < now - 24h`, so an order created this morning is not eligible until tomorrow morning — after the kitchen sheet has been worked and the food cooked. And it only flips `orders.status`: it never touches `daily_deliveries`, so a cancelled order's rows stay on every sheet. Nothing on 2026-08-24 had orphan rows, so some other path has been cleaning them; find out which before relying on it. **56 future delivery rows currently sit on unpaid `pending_payment` orders.**
- **Rows written at order creation do not decrement `orders.portions_remaining`.** Both orders above read `rem = package_size` with their whole package already booked, while orders booked through the normal path read correctly (Julian S: 5-porsi package, 3 rows, `rem = 2`). Two writers, one counter, and only one of them subtracts.
- **`daily_deliveries.status` has never been used: all 2851 rows read `scheduled`.** No row has ever been `delivered`, `skipped` or `cancelled`, so what the database calls a draw is "everything ever generated", not "everything delivered" — every customer who ever skipped a meal is over-drawn by exactly that much in the ledger, which is likely most of what `OVERDRAW.md`'s 32 are. Veronica was two rows over against the Google Sheet (2026-06-12 lunch, 2026-06-13 dinner, both order `7c0fc797`, deleted by `scripts/fix-veronica-phantom-rows.ts` with a rollback JSON) and she is **not** in `OVERDRAW.md`, so that file is undercounting. Two follow-ons: reconcile `daily_deliveries` against the sheet for everyone (a project, not a patch), and settle the disagreement that goes live the moment anyone writes the column — the ledger routes apply **no** status filter while `orderRemainingToday()` / `unbookedByOrder()` exclude `skipped` and `cancelled`.
- **A stated day pattern is thrown away.** "weekdays only", "tiap jumat libur" is read by the model, restated to the customer, then lost — nothing on `orders` records which weekdays a package runs on. Generation fills Senin–Sabtu minus closures. Durable fix is a per-order weekday mask; until then a stated pattern has to be corrected by hand after payment. Two customers already hit it (Sherine Fayola, Lina Marlianty), repaired by `scripts/fix-sheet-audit-0820.ts`.
- **The bot reads the customer's *newest* active order, not the one that should be drawn from.** `src/app/api/webhook/whatsapp/route.ts:1453` — a bare `.order("created_at", { ascending: false }).limit(1).maybeSingle()` on `status = "active"`, exactly the pattern `pickDrawOrder()` exists to replace. The row it picks feeds `portions_remaining`, `package_size` and `meal_time_preference` into the bot's context, so a customer holding two packages is quoted the balance of the wrong one. 85 customers hold two or more; Fahmi (`c23d0e79` with 0 left, `35093d5c` with 15) and Sky (`442f4cb8` with 20, `ff2b359c` pending) both do today. Fix: call `pickDrawOrder()` (`src/lib/orders/pick-draw-order.ts`) — oldest active with balance, else newest active.
- **32 open orders still carry a null `subcontractor_id`.** Down one from 33: Cindi's was assigned by hand on 2026-08-22. **No *future* `daily_deliveries` row carries a null kitchen any more** — all 12 that did were hers — so nothing is invisible on a kitchen sheet today, and this is a latent bug rather than a live one. Of the 32: 11 have a kitchen on the customer record to fall back to, 5 resolve to the single active kitchen covering their area, 4 are genuinely ambiguous (three kitchens cover BSD Baru/BSD Lama — those need a human to choose), and 12 have no `area` at all. New orders are protected going forward: `createOrderFromExtraction` now falls back to the customer's kitchen, then to the only active kitchen covering the area (`0cac69d`). These 32 pre-date it.
- **The Assistant's system prompt still names Agnes to the model.** `src/lib/claude/assistant-prompt.ts:29` — "admins (Justin, Annie, Agnes)". She quit and her `admin_users` row was deleted on 2026-08-20; Daevin is the current `admin`. One-line fix, but the same line will go stale again on 23 Agustus when his trial resolves — read `admin_users` instead of typing names, the way `getAssistantSystemPrompt()` already reads areas and the cutoff. Two comments also name her as the actor (`src/lib/push/send.ts:20`, `src/app/api/deliveries/addable-customers/route.ts:6`); those are history and can stay.
- **Sky holds a `pending_payment` order with `portions_remaining = 0`.** `ff2b359c-1889-4aa4-a4df-61df70142af7` (20 porsi, `both_fixed`) sits behind the active `442f4cb8` (20 porsi, 20 remaining, nothing booked). A pending order with a zeroed counter is the shape a duplicate leaves. Check whether it is a real second purchase before anyone marks it paid.
- **`linked_order_id` is honoured in one draw path out of four.** Only `addable-customers` (`src/app/api/deliveries/addable-customers/route.ts:65`) consults it. The daily-sheet POST, `bulk-create` and the `generate-deliveries` cron call `pickDrawOrder()` on the customer's own orders, so a linked customer charges their own (usually `pkg=0`) order. Only Darren Dior is linked today and he has not ordered since March — any new linked customer needs the other three fixed first.
- **A size reduced after a schedule exists leaves the surplus days.** `resizePendingOrderFromMessage` (`src/lib/claude/extract-order.ts:800`) shrinks the package but calls `fillMissingSchedule`, which only ever touches an order with zero delivery rows. Nothing has hit it yet.
- **No draw path checks the balance before writing**, so a fully-used order still goes negative. A hard reject in the daily-sheet `PUT` is unblocked for the reconciled set, but 72 customers hold a `package_size = 0` import artifact and must be backfilled first or the guard rejects their legitimate deliveries.
- **Renewal reminders miss anyone who skips the threshold.** `src/app/api/cron/renewal-reminders/route.ts:34,58` use `.eq("portions_remaining", threshold)` — a customer drawing 2 portions in a day steps over the value and is never reminded. Should be `<=` plus the already-sent guard.
- **`GET /api/customers?all=true` has a latent 1000-row cap.** `src/app/api/customers/route.ts:25` — plain `.select()` with no `.range()` loop. Harmless at 336 customers, silently wrong above 1000. Fix with `fetchAllRows()` from `src/lib/supabase/fetch-all.ts`. Architectural principle 9.
- **`/api/auth/check-admin` has no session verification** — allows unauthenticated admin email enumeration. Extract the email from the verified Supabase session instead.
- **No outbound scrubbing guard on subcontractor names.** The prompt forbids repeating a supplier name back and the model does it anyway, writing a real kitchen name straight into a reply. Prompt text is not enforcement; a scrub on outbound replies — built from the live `subcontractors.name` values, not a list — is the durable fix.
- **Three attribution gaps left open** (the rest closed 2026-08-21, see the `edit_log` section of `DATABASE.md`). `PATCH /api/customers/reorder` writes no `edit_log` row — one drag reorders many customers and would write a row per customer moved; deliberate, revisit only if display order ever matters. `POST /api/whatsapp/send` writes no `conversations` row at all, so a send through it is invisible to the inbox and carries no `sent_by`. And 14 routes still build their own inline `edit_log` insert instead of calling `logEdit()` — they work, they were left alone under the surgical-changes rule, and they will drift.
- **Every `conversations` row written before 2026-08-21 has `sent_by = null`.** Nothing backfills them because there is nothing to backfill them from: `model_used = 'human'` was the only marker a person typed it. Both messages sent to the ICE BSD thread that morning are in that set.

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

- **Delivery proof auto-send.** Call `sendDeliveryPhotoToCustomer(proofId, customerId, deliveries?, sentBy?)` directly in the POST route instead of the current "Ready to send" UI step. An auto-send has no admin behind it — pass `systemActor(...)` from `src/lib/audit/log-edit.ts`, not an empty string.
- **Accounting Phase 4** — "Balik jurnal" reverse-entry action: post a mirror entry (swap debit/credit), link via `reversed_journal_id` on `journals`. `source_type: "manual"` only; auto-posted entries stay locked.
- **Accounting Phase 5** — CSV export for journals/ledger (`?export=true`) and a quick-expense form that builds a 2-line balanced journal from account + amount.
- **Instagram daily post generator** (designed 2026-08-16, never started). One auto-generated post per day. Shape: `instagram_posts` table keyed `scheduled_for date UNIQUE` (that index is the idempotency guard), two jobs in the existing in-app scheduler (generate ~07:00 for tomorrow, publish ~11:00 today, both `catchUp: true` same-day), a public `instagram-media` bucket because Meta fetches the image by URL, and an `/instagram` review page. Store `ig_creation_id` between the two Graph calls — a retry after a partial failure must resume at publish or it double-posts. **The long pole is not code:** the Content Publishing API needs `instagram_content_publish` + `instagram_basic` through Meta App Review, and a Business/Creator IG account linked to a Facebook Page. Reuse the existing WhatsApp Meta app (already business-verified) and a Business Manager **System User** token, which does not expire. Open questions when resumed: AI-generated food imagery vs AI backgrounds behind real photos (the food we sell should not be a picture of food that never existed, and Meta labels AI images), auto-publish vs approve-first, and which image vendor.
- **Domain naming refactor** (big). `order` means the prepaid package everywhere and the daily portion-draw has no name. Preferred fix: add `drawdown` as the daily-draw layer, leave every existing `order` reference alone. The alternative (rename package → `package_order`, draw → `order`) has a blast radius across tables, routes, tools, chat and accounting descriptions.
- **Drop `customers.portions_remaining` and `customers.avg_price_per_portion`.** Dead columns, still written by six paths, read by none. Gated on the reconciliation chain: 27 customers hold a cached balance with no order behind it (Michelle Nathania's 30 portions the largest) and deriving turns those to 0.

---

## 7. Open questions

- **Rename `WINDOW_NOTICE_SHORT`?** The four exports in `src/lib/whatsapp/window-notice.ts` are named inconsistently — `WELCOME` and `CLAUSE` describe placement, `SHORT` describes size and implies a `LONG` that does not exist. `WINDOW_NOTICE_ORDER` or `_TRANSACTIONAL` would match. Six call sites plus the export. Asked, not answered.
