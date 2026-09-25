# The order site

The plan for a public menu-and-price catalog, plus a token-gated configurator that takes order intake off the chatbot. Written 2026-09-09, revised the same day to add the public layer. **Phase 4 is public** (since 2026-09-24): katerloka.com itself is the kitchen list, and the other catalog routes render from today's rows, with no menus yet. Nothing else here is built.

Read `docs/BOT_RULES.md` and `docs/OPERATIONS.md` first — every rule they carry has to survive this change, and most of them are why it is worth doing.

---

## What this is, and what it is not

It is **three layers**, and conflating them is the mistake the first draft of this plan made.

1. **A public catalog.** Menus, prices, areas and delivery days for every active kitchen, on ordinary URLs anyone can open, share and search. No token, no login, no chat first. This is the browsing layer, and at twenty kitchens there is nothing else that can do the job — the chat cannot carry twenty menus and twenty price sheets, and a link only an existing customer holds is invisible to someone still deciding.
2. **A configurator behind a token.** Everything personal: your name, your addresses, your Maps link, your kitchen, your remaining quota, and a form that opens part-filled because we already know all of it. The token buys *identity without a login*, nothing else. It was never meant to gate which pages exist.
3. **The thread.** WhatsApp stays the relationship and the transport. Support, day-by-day booking, skips, proof of delivery, invoices, escalation.

It is **not a destination for acquisition**. Ads still click straight into WhatsApp; sending a cold audience to a homepage funnel is where conversion dies. The public pages are where a conversation *goes* when it needs a catalog — the bot links into them, the customer links friends into them, and search finds them. Different job from the landing page at `/`, which exists for Meta's business verification.

It is **not a marketplace**. The kitchen anonymity decision of 2026-09-06 stands and gets harder here, not easier: customers see `subcontractors.customer_nickname`, never a real name, and a public page is one paste into a search engine away from undoing that. See "Anonymity on a public page" below.

We remain the principal (KBLI 56290): we buy from the kitchen, we set the price, we hold the contract, we issue the invoice, we bear the refund. The checkout is built on that assumption. See the KBLI task in `pnpm tasks`.

---

## The public catalog

**Why it has to be public.** Browsing and buying are different acts with different requirements. Buying needs to know who you are, so it is gated. Browsing must work for someone who has never messaged us, must survive being forwarded, and must be comparable side by side. A token-gated form fails all three, and the chat fails the last one hardest: two kitchens priced 55–65% apart cannot be compared by reading two images sent four messages apart.

**Routes.** All in the `src/app/(catalog)/` route group, outside `(dashboard)`. `src/proxy.ts` gates nothing — it only refreshes the session — so **these pages are public because their layout checks nothing** — the admin-only check and the `noindex` came out at launch on 2026-09-24. `/` is `(catalog)/page.tsx`: the old single-ladder landing page (`src/app/page.tsx`, `landing.css`) was deleted, and so was `(dashboard)/page.tsx`, a redirect to `/dashboard` that the landing page had always shadowed — sign-in goes to `/dashboard` by itself. The legal name, NIB, registered address and contact that Meta business verification matches against moved into the home list's footer and the JSON-LD on `/`. All rendered from rows filtered on `is_active = true` through `loadCatalog()` (`src/lib/catalog/kitchens.ts`), so deactivating a kitchen removes it everywhere at once, and a kitchen with no `customer_nickname` or no ladder is left off rather than shown half-built. The `CatalogKitchen` it returns carries no id and no real name, so a page cannot print one by accident.

| Route | What |
| --- | --- |
| `/` | Every active kitchen, cheapest first, each with its `catalog_blurb`, plus the area picker. The comparison surface. Built: area links, filters for size M, seven-day delivery and tanpa nasi. Not yet: filters by price band or style. `/menu` permanently redirects here, so a link shared during the preview still lands. |
| `/menu/[dapur]` | One kitchen: this week's and next week's menu, its ladder, its days, the areas it serves, its options (size M, tanpa nasi, nasi merah). Slug from the nickname, never the real name. Built: ladder, days, areas, size M and tanpa nasi. Not yet: the menu (waits on phase 3; the page says to ask for this week's by chat) and nasi merah (a constant in `extract-order.ts` until phase 2). |
| `/harga` | The ladders side by side, per kitchen, plus size M, tanpa nasi and delivery days. Rows are the union of every kitchen's sizes, each priced with `priceForPortions()`, so a kitchen with a different ladder shape still lines up. |
| `/area/[area]` | Which kitchens serve one area — the question customers actually open with. An area no active kitchen serves is a 404, not an empty page. |

**Location on open.** `/` asks for the visitor's location as it opens (`Locator` in `(catalog)/locate.tsx`) — Justin's choice on 2026-09-24, over a button, knowing a refused prompt cannot be re-asked by the page. A match sends them to that area's page; no match leaves the full list with "Belum ada dapur partner yang antar ke lokasi kakak" and a chat link; a refusal on open shows nothing. The picker's "Gunakan lokasi saya" asks again, and only a refusal *after pressing it* gets a note, or the button would look dead. It asks once per tab session (`sessionStorage`), because otherwise choosing "Semua area" would land on `/` and bounce straight back to the area. **Areas have no borders we can draw** — the Tangerang ones are developer townships — so the area is that of the nearest neighbourhood with a point (`area_neighborhoods.lat/lng`, migration 139), within 4 km, matched server-side by `POST /api/catalog/locate`. The page rounds the position to ~100 m before sending it, and the server neither stores nor logs it. The points were geocoded from each name through OpenStreetMap on 2026-09-24 and every hit more than 5 km from its area's centre retried with the township named, then dropped if it still missed: a same-named cluster elsewhere (a "Topaz" in Batuceper, a "Living World" in PIK) would send a visitor to the wrong area, where an empty row is merely skipped. 23 of 275 stayed empty. **A new neighbourhood needs a point too**, or the location match cannot see it — it still works for the bot. **Karawaci had one point** (Cendana Cove) until migration 140, so most of Lippo Karawaci resolved to Gading Serpong, whose northern clusters are closer — four of eleven pinned Karawaci customers did. It now has thirteen, named from what its customers typed (UPH, U Residence, Permata Bunda, Taman Ubud) plus the township's landmarks, and replaying the audit moved those four and one far-north customer to Karawaci while no other customer's match changed. Pinangsia is left out: 0.9 km from Sektor 1D, it would take part of Gading Serpong. **A place near an area that no kitchen reaches needs an excluded point**, or it is matched to that area: Banjar Wijaya (Cipondoh) read as Alam Sutera until migration 141 placed it as an excluded row.

**Every page ends in the same place: a click-to-chat.** `wa.me/<number>?text=<code>` where the code names what they were looking at. The customer sends it, that opens the 24-hour window, and the bot picks up already knowing the kitchen and the package. This is not a nicety — with the WABA carrying the 131042 restriction we cannot initiate to a number that has not written to us, so **the customer must be the one who opens the conversation**. A public page that tried to collect a phone number and text them back would fail silently.

**What the bot sends changes.** Never twenty of anything. Ask the area first — that alone narrows twenty kitchens to the two to four that serve it — then send one comparison link. The individual price sheet stays available on request: *"boleh lihat harga Dapur Palem?"* → that one image.

**Anonymity on a public page.** Republishing a kitchen's own menu wording verbatim identifies them to anyone who searches a distinctive line, and their real card is often already on their own social accounts. Public copy must be **ours**: our wording, our photography, our dish names. Never their card reproduced, never their file names, never their EXIF. This is a hard requirement on the content, not a caveat on it.

**Price transparency runs both ways.** A public ladder is readable by our kitchens as well as our customers, and makes the resale premium a single click to compute. It is already visible to any kitchen that asks a customer, but this removes the friction. It does not change whether to publish; it is why the wholesale rates were negotiated first, which Justin has done (reported 2026-09-24).

---

## Why a form and not a better prompt

`extract_order` is structured data entry conducted in free text. Before it may fire it has to have elicited: kitchen, area, address, a Google Maps link, package size, size S or M, rice variant, meal times, and an explicit list of dates. Almost every bot task in the queue is a runtime refusal for a state a form makes unrepresentable:

- a 7-porsi package that is not on any ladder,
- a Minggu quoted to a customer whose kitchen does not cook Minggu,
- a schedule inferred from a preference enum nobody confirmed,
- an M order sent to a kitchen that only cooks S,
- a kitchen the customer never named,
- an address overwritten with a sub-area.

A form does not guard those. It cannot express them. Pick the area and only kitchens serving it appear; pick a kitchen and only their delivery days are selectable, only their ladder quotes, size M appears only if `offers_size_m`. The price is computed on the server and displayed, never spoken by a model, so the claim checker has nothing left to validate on the order path.

The cost of the current design grows as kitchens × areas × days × options. At three kitchens we are already paying it. At ten it is not tractable.

---

## The split

| Owner | What |
| --- | --- |
| **Public pages** | Browsing and comparison: menus, ladders, delivery days, areas. No token, no personal data on them at all. |
| **Form** | Everything that becomes a row: new orders, top-ups, the delivery schedule, area / address / Maps link, kitchen choice, size, rice variant, per-day kitchen split, and payment. |
| **Bot** | FAQ, menu and price questions, "besok libur ga?", day-by-day booking and skips for existing customers (`record_daily_order`, `delete_deliveries` — genuinely conversational, already guarded by `isLocked()`), delivery proof, invoices, escalation, and nudging people back to the link. |
| **Retired** | `extract_order` and the machinery around it: the price list rendered into the system prompt, `resizePendingOrderFromMessage`, and most of the validator's order-side work. Payment proof handling stays, because checkout is still a manual transfer (see Checkout). |

**The price sheet images stay, for one kitchen at a time.** They are a forwardable, zero-tap artifact that renders in the thread, survives offline and is the thing someone screenshots for their spouse. What breaks at ten kitchens is the delivery mechanism, not the format — you cannot send ten images, and a composite of ten is unreadable on a phone. So `send_price_list` becomes: narrow by area, send the comparison **link**, and send an individual sheet only when one kitchen is named. `scripts/price-list.ts` also needs a second layout, because Homey's real card is a drop-size table and the generator only knows how to draw a package-size ladder.

---

## Identity without a login

Customers do not have accounts and must never be asked to make one.

**Route:** `/pesan/[token]` — public, outside the `(dashboard)` group, excluded from any auth gate in `src/proxy.ts`.

**New table `order_links`:**

| Column | Notes |
| --- | --- |
| `id` | uuid |
| `token` | text, unique — 32 random bytes, base64url. Not derived from anything about the customer |
| `customer_id` | uuid FK → customers. The link is bound to one person |
| `purpose` | `new_order` \| `topup` \| `reorder` |
| `prefill` | jsonb — what the chat already established, so the form opens part-filled |
| `expires_at` | timestamptz — 72 hours. Re-issuable; the bot can always send a fresh one |
| `used_at` | timestamptz — stamped when an order is created through it. A used link still renders that order's payment page, but starts no second order |
| `created_by` | text — `system:webhook` or an admin email |
| `created_at` | |

Rules that make this safe:

- The token is the whole credential, so it must never appear anywhere a third party can read it: it is sent to the customer's own WhatsApp thread and nowhere else, never logged, and never put in an image or a page title.
- The page loads through the admin client behind a server-side token check. **Never expose the anon key to this route** and never rely on RLS to scope it.
- It reveals only what that customer already knows about themselves: their name, their addresses, their Maps link, their kitchen, and their remaining quota. No other customer's data, no cost figures, no kitchen real names, no margins.
- Rate-limit by token and by IP. A token that 404s must look identical to one that has expired, so the space cannot be probed.
- Every write through it records an actor of `customer:<id> via order_link` in `edit_log`, so the audit trail keeps working. `logEdit()` already never throws.
- PII on a public URL is the reason for the 72-hour expiry. Sensitive fields stay off the page entirely rather than being hidden in the markup.

**A customer with no token.** Someone arriving from a public page or a search has no row, no thread and no token, and we cannot text them one. They configure on the public side as far as the form can go without knowing who they are — kitchen, package, days — and the page hands off to `wa.me/<number>?text=<code>`, where the code is a short opaque reference to that draft. Sending it opens the 24-hour window; the bot resolves the code, creates or matches the customer on the phone number the webhook carries, and replies with a real `/pesan/[token]` link for the parts that need identity: address, Maps link, payment. **The draft holds no personal data** — it is a configuration, not a customer — so it can live in a short-lived table keyed on the code and expire in 24 hours.

**A tool replaces a tool.** `extract_order` goes; `send_order_link` arrives. It creates the row, sends the URL, and returns what it actually did — the outcome, in the model's own third-person voice, per the tool-result rule in `CLAUDE.md`.

---

## The flow, and what backs each step

Every step is driven by rows. Nothing on this list is a constant in code.

1. **Confirm who you are.** Name from `customers.name`, phone locked to the token. A missing name is asked for here rather than by the bot, which is where `record_customer_name` keeps failing.
2. **Address.** Area from `activeDeliveryAreas(db)`; sub-area, address text, address type. **The Maps link is required** and validated with `findMapsLink()` / `isSharedPinLink()` (`src/lib/maps/link.ts`) — a form is the right place to demand it, and 290 of 448 customers still have none. Second address supported, since `customers` already carries `address_2` and the slot columns.
3. **Kitchen.** `kitchensForCustomer()` / `kitchensForCustomerArea()` (`src/lib/subcontractors/for-customer.ts`), narrowed by `kitchenCoverage()` and its exclusions (`coverage.ts`). Each card shows the nickname, its menu identity, its price band and its delivery days — never a real name. A returning customer's own kitchen is preselected from `customers.subcontractor_id` and is labelled as such.
4. **Package.** Ladder from `tiersForKitchen()`, priced with `priceForPortions()` (`src/lib/pricing/tiers.ts`) — per kitchen; there is no house ladder (migration 135), so the package step cannot render before a kitchen is chosen. Size M offered only where `offers_size_m` is true, priced with `kitchenMSurcharge(db, subcontractorId)`. Rice variant from that kitchen's `no_rice_discount`. `customers.contract_price_per_portion` replaces the ladder entirely when set. Off-list totals cannot be typed: the control offers only sellable sizes, which is the whole 7-porsi class of bug gone.
5. **Calendar.** Dates from `deliveryCalendar()` / `earliestDeliveryDate()` (`src/lib/time/jakarta.ts`) against that kitchen's `delivery_days` via `kitchenDeliversOn()`, with `isClosedHoliday()` and `OPEN_DESPITE_HOLIDAY` applied and the `settings.order_deadline_hour` cutoff enforced. Per day: meal, portions, and optionally a different kitchen — migration 102 already lets a delivery carry its own `subcontractor_id` and frozen `price_per_portion`, so one package split across dapur is expressible here from day one. Booking day by day stays available: that writes `requested_schedule` as `[]`, exactly as today.
6. **Review and pay.** The server recomputes every figure from the rows and ignores anything priced by the client. Then checkout.

---

## The server contract

**One order-creation core, two callers.** `createOrderFromExtraction()` (`src/lib/claude/extract-order.ts:1402`) today mixes three jobs: validation and pricing, the database writes, and sending WhatsApp messages. Split it:

- `createOrder(input): Promise<CreateOrderResult>` — pure of messaging. Owns the divisibility rule (a total off the list but divisible by 5 or 6 sells at the rate of the largest listed size below it, anything else is refused), the beneficiary rules, `paid_by_customer_id`, the size and rice arithmetic, the surcharge copy from `subcontractor_neighborhoods`, and writing `requested_schedule` once.
- The bot path keeps a thin wrapper that does the sending it does now, including `deferPaymentMessage`.
- The web path is `POST /api/public/orders`, token-gated, which calls the same core and returns the payment page.

Non-negotiables carried over unchanged:

- Server-controlled fields (`id`, `created_at`, `status`, `total_price`, `price_per_portion`) are never accepted from the client, and updates use an explicit allowlist.
- **Delivery rows still land only when the order is marked paid**, through `buildPaidDeliveryRows()`. Nothing about a web form changes that, and the daily sheet still keys on `delivery_date` alone.
- One order per purchase: a second submission inside the amend window amends the open `pending_payment` order rather than inserting a twin. The link's `used_at` plus a client nonce make the submit idempotent.
- Third-party purchases keep going to the beneficiary, with the buyer in `paid_by_customer_id`.

---

## Checkout

**Decided 2026-09-23: checkout is a manual bank transfer, verified by an admin.** No payment provider and no QRIS for now. The page shows the transfer details, the customer uploads a slip, and a person marks it paid — the same path the chat takes today, moved onto the order page.

- **The bank details come from `settings`** (`bank_name`, `bank_account_number`, `bank_account_name`), composed by the server into the payment page exactly as `createOrderFromExtraction` composes them into the chat. Never typed into a page template, and still never into a prompt.
- The page shows the account, the exact total with ongkir from `subcontractor_neighborhoods`, a copy button on each, and the deadline: 16:00 WIB the day before the first date in `requested_schedule` (`settings.order_deadline_hour`). A day-by-day order has no first date, so it gets no date on the deadline line.
- **The slip is uploaded on the page**, with WhatsApp kept as the other way in. An upload goes through the same `readPaymentSlip()` as a chat photo: it writes what it read to `orders.payment_proof_read` and moves the order to `payment_proof_received`, and stops there.
- **`paid_at` stays a human decision**, at `/payments`, for the reason in `docs/BOT_RULES.md`: `mark_paid` writes `daily_deliveries` rows and nothing filters the kitchen sheet by status, so a forged or misread screenshot becomes cooked food. The page says so in plain words — the schedule reaches the kitchen after an admin confirms — and the confirmation goes out on WhatsApp.
- No stored-value wallet, no cross-kitchen saldo: general-purpose stored value edges into uang elektronik and BI licensing.

What this keeps, that a provider would have retired: `mark_payment_proof_received`, proof handling, the `payment_proof_received` status and an admin checking every transfer. Refunds stay a manual transfer, as Carolin's Rp 87.000 was.

**If a provider comes back**, build against an adapter, not a provider — `createCharge({ orderId, amountIdr, customer })` and `verifyWebhook(rawBody, headers)` — with the webhook discipline unchanged (verify the signature, land the raw payload in `webhook_events`, 200, process async, dedupe on the provider transaction id), the fee absorbed (Bank Indonesia forbids passing MDR to the customer), and no QR image ever sent into WhatsApp, since dynamic QRIS expires in minutes and a business-initiated send fails on 131042. Manual transfer would then stay as the outage fallback and the corporate NPWP path. The Midtrans/QRIS task in `pnpm tasks` holds that question.

---

## The tables this needs behind it

**Per-kitchen cost.** `subcontractors.cost_per_portion` is a scalar and Homey's cost is a curve: 33.000 for one box at a stop, falling to 27.000 at five, with a separate tanpa-nasi column. Our book is 78% single-portion drops, so the scalar is right for the dominant case and wrong everywhere else, and it silently misstates COGS. Needs a `kitchen_costs` table keyed on `(subcontractor_id, size, rice, drop_size_min)`, read through `kitchenCostPerPortion()` (`src/lib/orders/size.ts`), which is already the single read site.

**Per-kitchen options.** Two product options are currently hardcoded or house-wide: `NASI_MERAH_SURCHARGE = 5000` (`extract-order.ts:653`, Thenie-specific) and the tanpa-nasi delta, which only became per-kitchen by accident of `no_rice_discount` being a column. Size M left that list on 2026-09-22: migration 131 gave it `subcontractors.size_m_surcharge`, the third option to become a column rather than a table. A `kitchen_options` table — `(subcontractor_id, key, label, customer_delta, kitchen_cost_delta, active)` — makes the form's option list a query and stops the next option being another constant. Ongkir stays where it is, on `subcontractor_neighborhoods`.

**Structured menus.** This is the prerequisite the token-only plan let us skip. A menu today is `subcontractors.menu_image_url` (a weekly JPEG), `menu_text` (a blob injected into the system prompt) and `menu_week_start`. An image cannot be filtered, compared, searched, or sorted, so no catalog can be built on it. Needs `kitchen_menu_items (subcontractor_id, week_start, weekday, meal, item, tags[])` — and then the **image becomes a render of the rows**, not the source: `scripts/menu-card.ts` already draws cards from data, so the weekly upload becomes a weekly data entry that produces the same JPEG the thread sends today. `menu_text` stops being hand-maintained and is composed from the rows, which also ends the drift between what the prompt says and what the picture shows.

**Invariant to enforce at ladder creation, not at quote time:** a kitchen whose bottom tier sits under its own cost at the worst drop size must be rejected at setup. Otherwise someone buys 120 portions and routes them to a kitchen we lose money on.

---

## Order of work

Each phase is shippable on its own and leaves the bot path working.

1. **Extract `createOrder()`** from `createOrderFromExtraction()`, bot wrapper on top. Verify: the existing suite passes untouched; the bot creates orders exactly as before.
2. **`kitchen_costs` + `kitchen_options`** (two migrations, numbered from 138) with the current values seeded, readers switched, `NASI_MERAH_SURCHARGE` deleted. Verify: quotes for all three kitchens unchanged; COGS on a Homey multi-box drop now differs, and that difference is the bug being fixed.
3. **`kitchen_menu_items`** (one migration) with the current weeks entered, `menu_text` composed from the rows, `scripts/menu-card.ts` rendering the weekly image from them. Verify: the image the thread sends is unchanged to a customer's eye; the prompt's menu text and the picture can no longer disagree.
4. **The public catalog** — `/`, `/menu/[dapur]`, `/harga`, `/area/[area]`, each ending in a click-to-chat. No token, no personal data, no writes. **Built ahead of phases 1–3 and public since 2026-09-24**, because everything but the menu already had rows; it gains menus when phase 3 lands. It follows the food-delivery-app layout approved on 2026-09-23 (home list with area picker and filter chips, kitchen page with Paket / Menu / Info tabs, bottom tab bar), minus every part of that design no row backs yet: kitchen photos (a flat colour stands in), the weekly menu and the "Menu minggu ini" strip, search, and the Pesananku tab (phase 5). A package's **Pesan** opens WhatsApp with that package typed out; the cart, checkout and payment screens are phases 6–7. Verify: nothing on any page names a kitchen or reproduces its own copy; every figure traces to a row; the pages render with one kitchen active and with twenty.
5. **`order_links` + `/pesan/[token]`** (one migration) rendering read-only: who you are, your kitchen, your quota. No writes. Verify: an expired and a nonexistent token are indistinguishable; nothing renders for a token that is not yours.
6. **The configurator**, steps 1–5, ending at the existing manual-transfer instructions. `send_order_link` added to the bot; `extract_order` still live behind it. Verify: an order placed through the form is byte-identical in the database to the same order placed through the bot.
7. **Checkout**: the transfer page and slip upload, reading the bank details from `settings`. Verify: an uploaded slip lands in `payment_proof_read` and moves the order to `payment_proof_received` without stamping `paid_at` or writing a delivery row; marking it paid at `/payments` writes the rows exactly as it does for a chat order.
8. **Retire `extract_order`** and its prompt machinery once the form has carried real orders for a fortnight. Verify: the bot cannot create an order at all — the only path is the link.
9. **`send_price_list` rework** and the drop-size sheet layout.

Phases 1 to 3 are worth doing whatever happens to the rest: they are the multi-kitchen architecture debt — one order core, per-kitchen cost and options, menus as data — and the site only makes them urgent. Phase 4 ships value on its own even if the configurator never follows, because the browsing problem is the one that is already unsolved at three kitchens.

---

## The customers who have only ever used chat

209 customers hold a live order right now (320 orders across `active`, `paused`, `pending_payment` and `payment_proof_received`), and none of them have ever seen a form.

Nothing migrates. Their existing orders, quota and delivery rows are untouched — the form writes the same rows to the same tables. What changes is only how the *next* order is placed:

- Day-by-day booking and skips stay in chat, so most customers meet the form only at renewal.
- At renewal the bot sends a link whose `prefill` already carries their kitchen, addresses, size and rice variant. Three taps, not twelve questions.
- Anyone who cannot or will not use the link is served by an admin through the dashboard's new-order form, which is the same core.
- The 290 customers with no `google_maps_link` get asked for one by the form the first time they use it, which closes that gap faster than the bot has been managing.

---

## What must not regress

Short list, because these are the ones a rewrite quietly breaks. The reasons are in `docs/BOT_RULES.md` and `docs/OPERATIONS.md`.

- Kitchen real names never reach a customer, on any page, in any error, in any URL, in any slug, in any image file name or its EXIF.
- Public pages carry no personal data of any customer, and no cost, margin or COGS figure.
- Delivery rows land at payment, never at order creation.
- A delivery row is present or absent — no status column, and a skip is a delete.
- The customer picks the kitchen; area only narrows the list.
- Sisa kuota is counted from the rows, never from `customers.portions_remaining`.
- Every dashboard-side write goes through an API route so `logEdit()` can record it.
- No unbounded select: paginate with `.range()`, aggregate in the database.
- Bank details are composed by the server, never placed in a prompt or a page template.

---

## Open before this starts

- **Payment provider.** Not needed to launch: checkout is a manual transfer (decided 2026-09-23). Midtrans and Xendit registration were both stuck as of 2026-09-09; revisit when admin verification becomes the bottleneck.
- **PSE registration with Kominfo** is a separate obligation from KBLI and applies to a public-facing electronic system. Confirm before checkout goes live.
- **The rebrand.** "Pian Yi" (便宜, cheap) anchors a price band we have already left. `business_name` is a setting the prompt reads, but there are ~41 hardcoded strings in `src` and `scripts`, plus the invoice renderer, the manifest and the legal pages — and the WhatsApp Display Name change goes through Meta review, which is the slow part. **The name is Katerloka** (kater + *loka*, "the world of catering"), chosen 2026-09-23 over descriptive names like KateringHub, which DJKI would likely refuse under Article 20 of UU 20/2016. PDKI found no match on the normal search that day or on the phonetic (*Fonetik*) search on 2026-09-24; the filing itself (classes 35 and 43, first-to-file) is still to do. **katerloka.com is bought** (2026-09-23, at Jagoan Hosting, auto-renew on, due 2027-09-23) and **serves the app since 2026-09-24**, added to Railway *alongside* `pian-yi.up.railway.app` rather than replacing it, so the webhook, admin logins and installed PWAs never move. Apex and `www` each need two Cloudflare records, both DNS-only: a CNAME to the target Railway names, and a TXT at `_railway-verify` (`_railway-verify.www`) carrying its token. Railway lists only the CNAME when the domain is created, and the certificate sits in "validating ownership" forever without the TXT; read `verificationDnsHost`/`verificationToken` off the domain's status in the GraphQL API. `railway domain <name>` answers "Unauthorized" on a fresh login while the same token creates it through the API (`customDomainCreate`). Railway needs a CNAME, which an apex domain can only carry on a DNS host that flattens it, so the nameservers went to Cloudflare's free plan (active 2026-09-24; zone empty apart from email). `halo@katerloka.com` forwards to Justin's Gmail through Cloudflare Email Routing — receive only. DNS changes go through the Cloudflare API with `CLOUDFLARE_API_TOKEN` from `.env.local`, a token scoped to this one zone and never set on Railway, since the app does not use it. katerloka.id is unbought.
- **Menu identity per kitchen** — done 2026-09-24 as `subcontractors.catalog_blurb` (migration 138): one public line per kitchen on the food and the delivery, shown on the home list and the kitchen page, edited in the kitchen's dialog at `/subcontractors`. "Dapur Monstera" and "Dapur Suplir" alone gave a customer no basis to choose between two kitchens priced 55–65% apart. The first four were written from each kitchen's `menu_text` and `notes`. **The line is public text: never a kitchen's name, neighbourhood, packaging or anything else a customer could search to find who cooks.**
