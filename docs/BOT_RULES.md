# Bot rules — the WhatsApp chatbot

Read this before changing anything the customer-facing bot says or does: `src/lib/claude/prompts/system.ts`, `src/lib/claude/extract-order.ts`, the webhook's reply handling, or the order-recovery guards.

Nearly every rule here is the residue of a real conversation that cost a real order. The incident is kept with the rule on purpose — a rule stripped of its reason gets "simplified" back into the bug by the next person. `CLAUDE.md` carries the one-line version of the hardest ones.

## Confidentiality (critical)

- **Never** disclose a subcontractor's real name to customers, in any form. Every row in `subcontractors`, present and future — the rule is never an enumerated list, in this doc or the prompt
- Frame as **"dapur partner kami"** (our partner kitchen). This used to read "dapur kami — implies internal operations", i.e. the goal was to make customers believe we cook in-house, which is what produced the bot answering "katering sendiri" and then flatly denying a named supplier. What is confidential is *which* kitchens, never that we work with kitchens at all. "Dapur kami" in passing is fine; using it to claim in-house cooking is not.
- **A customer who names a supplier gets neither a denial nor a confirmation.** We really do cook through partner kitchens, so "bukan kak, kami masak sendiri" is a lie the customer can find out — a worse outcome than the question. The rule (next to the "dapur kami" line in `system.ts`) is to say openly that we work with partner kitchens and keep which ones private: "Kami masak lewat dapur partner kak, cuma namanya memang nggak kami sebutkan ya." This replaced a flat-denial rule written on 2026-08-16 and reverted the same day for exactly that reason. Confidentiality here is about *which* kitchens, never about whether they exist.
- The prompt also says never to repeat back the name the customer used, and the model **does anyway** — under the denial rule it wrote a supplier's real name straight back at the customer ("… itu bukan bagian dari kami"). Prompt text is not enforcement; a scrubbing guard on outbound replies is the durable fix and is not built yet.
- Customer-facing error messages are always generic; never leak technical details
- Never reveal COGS, profit margins, or internal operations
- **The account number is not in the model's context at all.** `buildSystemPrompt` deliberately fetches only `bank_name` — never `bank_account_number` or `bank_account_name` — because the payment message is composed and sent by `createOrderFromExtraction` (`src/lib/claude/extract-order.ts`), so the model has never needed them. It used to list the full number as plain business info, and on 2026-08-16 a simulated stranger with no order, no agreed price and no confirmation asked "rekeningnya berapa kak?" and got it. The prompt now states the number is sent automatically after confirmation and gives the deflection line; that is the second layer, not the fix. Do not re-add the number to the prompt — the "After order confirmation" section no longer carries the transfer template for the same reason.
- **The order's own figures do come back, and they outrank the model's arithmetic.** "Never repeat what the system sent" was written about the *account number* and had quietly grown to cover the *amount* as well: `handleToolUse` returned a fixed "Order berhasil dicatat" and the model was told not to restate the nominal, so it never learned what had actually been written. Rachel asked for 4 hari × 1 porsi on 2026-08-31 and was quoted "4 porsi × Rp 29.000 = Rp 116.000" — a package that does not exist; `createOrderFromExtraction` raised it to the 5-porsi floor and sent Rp 145.000; the model, holding only its own number, told her to **ignore** the Rp 145.000 and transfer Rp 116.000. The `extract_order` tool result now carries `packageSize`, `pricePerPortion`, `totalPrice` and `size` from the row that was written (`CreateOrderResult.order`), and instructs the model to own the difference rather than talk over it. The account number is still not in there and never will be. Two prompt rules go with it: **the days are free but the total is not** — multiply the days out and check the result against the size rule before quoting it — and **never tell a customer to ignore the amount the system sent, and never name a transfer figure of your own.**

## Language & tone

- All customer-facing messages in Indonesian only. Enforced, not just asked for: `looksEnglish()` (`src/lib/claude/language.ts`) checks every outbound webhook reply after the hallucination validator, and an English one is translated by Haiku rather than regenerated — the reply is usually correct and already matches whatever tool was called alongside it. The model slips mainly on the short sentence accompanying a tool call ("I'll send the menu image for you to check." in a 2026-08-15 simulator run). The check needs zero Indonesian markers and two English ones, so borrowed words customers use anyway ("next week", "cancel") never trigger a rewrite.
- **The hallucination validator (`src/lib/claude/validate-reply.ts`) is given the tail of the conversation, not only the database.** It asks Haiku whether the draft states a customer-specific fact — name, quota, package size, order or payment status — that the verified CONTEXT does not support, and a rejected draft is regenerated once, then replaced by a canned line while the thread is parked with `pending_bot_response: true`. With only DB facts in CONTEXT, the one turn where the bot reads an order back **before it exists** is unsupported by construction: on 2026-08-18 a new customer agreeing to 8 porsi from Rabu 19 Agustus had two drafts blocked in a row and got "Bentar ya kak, aku cek dulu sama admin" instead of an answer, with the order never created. The last 10 history messages plus the incoming one now go in as CONVERSATION SO FAR, and the prompt states that anything the customer said there is supported. An invented quota ("sisa kuota kakak masih 12 porsi") is still blocked — the transcript is what separates reading back from making up.
- `sanitizeReply()` (`src/lib/claude/sanitize-reply.ts`) runs last on every outbound webhook reply — after the validator, after the language guard — and the cleaned text is what gets saved, so the inbox shows what the customer actually received. It strips quotes wrapping the whole reply, drops a paragraph repeated verbatim, and cuts a leaked reasoning preamble. The leak is the serious one: `NO_THINKING` stops DeepSeek emitting a `thinking` block but not its deliberation landing in the text block, glued to the answer with no space after the full stop ("…no more than 200 words.Betul kak, …", 2026-08-16 simulator). `looksEnglish()` cannot classify those paragraphs — it returns `false` on any Indonesian marker and the deliberation quotes the customer's own words ("minggu", "kak") — so detection also matches the model talking to itself (`REASONING_OPENERS`: "Hmm", "Let me", "I should", …). If nothing survives as an answer the reply is returned untouched, leaving a genuinely English reply for the language guard. It also drops a **retracted false start** — the Indonesian sibling of that leak, which `REASONING_OPENERS` cannot see: asked for 13 porsi on 2026-08-16 the bot sent a wrong package list, cut itself off mid-number ("atau 14..."), then wrote "Sebentar, izinkan saya cek lagi." and answered again. Only unambiguous self-corrections match, and only with an answer after them — "Sebentar ya kak, saya cek dulu" is a real thing to say while asking an admin. Last, `**markdown bold**` is rewritten to WhatsApp's `*bold*`; the prompt has forbidden `**` since the formatting section was written and the model still emitted `**Rp 1.300.000**` two replies after `*Rp 420.000*`, so this is enforcement, not instruction.
- Use "kak" as honorific
- Bot replies under 200 words always
- Use emojis sparingly but warmly
- 50% of conversational messages should be casual (lowercase, no punctuation, no emojis) to feel human; transactional messages (order summaries, bank details, payments) must always be polished
- Contextual "ok" handling: post-delivery "ok" gets an enjoy-food reply; a generic affirmative "ok" gets a closing thanks only ("Baik kak, terima kasih ya 😊") — bot must not ask "Ada yang bisa kami bantu lagi?"

## Ordering flow (chatbot)

- **There is one product: a paket porsi (a quota of portions).** Q0 ("jadwal tetap atau pesan bebas?") is gone from `system.ts` — it asked customers to pick a product that does not exist. Both paths always priced identically (`package_size × price_per_portion`), and the data said customers ignored the distinction anyway: 78% of orders booked a block of days upfront regardless of which one they chose, and only 2 of 51 sampled orders were genuinely decided day by day. Never reintroduce the question.
- Whether a customer's days are booked ahead is a **scheduling detail asked after the price is agreed**, not a product choice: "Mau sekalian saya jadwalkan hari-harinya kak, atau pesan bebas aja per hari?" Skip it entirely if they already described a schedule. It does not change the price.
- The bot asks days / meal-preference / portions-per-delivery / kitchen as one combined message instead of one-at-a-time, to cut WA round-trips. It re-asks only whichever field the customer didn't answer.
- One order form for everyone. The four scheduling fields at the bottom (meal preference, porsi per pengiriman, tanggal mulai, tanggal selesai) are optional and dropped entirely for a customer ordering bebas — their absence is not a missing field.
- **The list of served areas is read, never recited.** What Pian Yi delivers to is the union of `delivery_areas` across the subcontractors with `is_active = true`; each kitchen has its own list and the lists overlap only in part, so the union changes whenever a kitchen is activated or deactivated. The bot receives it as `servedAreas` in `buildSystemPrompt`, and the welcome message resolves `{{delivery_areas}}` at send time. Never hardcode the areas in the prompt, a template or a reply, and never answer an area question from memory — on 2026-08-21 the docs still claimed Bintaro and Graha Raya, which no active kitchen has served for months. See "Delivery areas" in `OPERATIONS.md`.

- **Delivery area never blocks order creation.** The address line is a cluster plus a kecamatan plus a postcode and only the cluster is in `area_neighborhoods`, so the prompt matches on any fragment; a match anywhere wins. If nothing matches the bot asks once, then picks the nearest served area itself and calls `extract_order` — a wrong area is one field an admin fixes, an unanswered question is an order that never exists. Janice's "Cluster Allogio Timur 3 No.32, Pagedangan" is the case: Allogio is listed under Gading Serpong (which is where her real customer row sits), the bot read "Pagedangan", and asked which area it was four times running while she answered everything else.
- **Meal choice and porsi per pengiriman never hold an order open.** Ask once, state the default in the same message (makan siang, 1 porsi per pengiriman), and call `extract_order` with it — both fields are one click for an admin to change. Lina Marlianty gave "2 minggu, 1 porsi" and her address on 2026-08-18, was asked twice which meal, and her 10-porsi order was never created. **That default belongs to a scheduled order and to nothing else.** For a customer ordering *bebas* — no days named, `delivery_schedule: []` — the meal is chosen per pengiriman when they ask for one, and there is no column to hold a default: `orders.meal_time_preference` went with migration 077 and `requested_schedule` is null for them. Rian was told "meal-nya saya set makan siang dulu, gampang diubah kok" on 2026-08-29 and nothing had been set, so there was nothing to change and nothing to read back when he next said "yang kemarin aja" — the empty claim this file forbids for orders, in its milder form. The prompt now says so explicitly in the bebas bullet of "Scheduling the days".
- **A note added after the summary is not a correction.** "Porsi 1/2", "tanpa lemak", a room number — record it and call the tool. Cindy answered a summary with "okay kak, saya request porsi 1/2" and got the summary printed again.
- **`extract_order`'s schema lives in one place** — `EXTRACT_ORDER_PROPERTIES` in `src/lib/claude/extract-order.ts`, used by both the webhook and the admin inbox extraction. The webhook used to carry its own copy, and the copy had lost `delivery_schedule` entirely: the live bot could only give a start and an end, which get filled in by weekday, so any customer who skipped a day (Cindy's 11, 12, 13, 14, 18 Agustus) got a different set of days than they asked for. Only the `required` list differs between the two call sites.
- **Name, total portions and address are required to create an order; everything else has a prompt-level default.** Meal falls back to makan siang, porsi per pengiriman to 1, start date to the next delivery day, area to the nearest served one — filled silently, stated in one clause, and never a reason to end a turn with a question. The name is the one exception and it is not fillable: see "The name is asked before the bank details, and the tool enforces it" below. Tiwi gave 6 porsi, an address and a maps pin on 2026-08-18, was asked her name once more, and her Rp 174.000 order was never created — she transferred anyway. Asking where to pay ("bayar kemana kak?", "mohon kabari nomor rekening") is itself a confirmation and must produce `extract_order` in that turn.
- **An honorific is not a name, and the honorific never goes in the sentence.** The prompt used to tell the model to send the literal `"Kak"` as `customer_name` when the customer never gave one; `customer_name` is a required field, so it did. That string was stored on the customer and then read back out by every greeting — +6285692715738 was addressed as "Halo kak Kak!" on 2026-08-26 and carried "Kak" as their name on their order, their inbox thread and their delivery label. Two guards now: the prompt asks for an empty string, and `isPlaceholderName()` (`src/lib/claude/extract-order.ts`) drops `kak`/`kakak`/`unknown`/`customer`/`pelanggan`/`-` on the way in, so a future prompt edit cannot reintroduce it. Exact match only — "Kakang" is a real name. The bot now **asks for the name and waits for it** before `extract_order` runs at all (see the next section) — the Tiwi rule survives as its other half: the moment the name arrives, the order must follow in the same turn. Asking used to create a promise the bot could not keep: nothing but `extract_order` could write a name, so when she answered "keira" the bot said "nama kakak sudah saya catat sebagai *Keira*" and wrote nothing — the empty claim this file already forbids for orders. **`record_customer_name` is the write path**, and `shouldRecordName()` gates it: a real name, and only onto a record that has none, so a misread signature cannot rename someone an admin named. It is not offered when drafting a reply for the compose box — a draft the admin discards must leave nothing behind. The same rule covers the prompt-injection branch: `detectInjection()` used to set `customer_flags.is_suspicious` even under `draft: true`, so an admin previewing a reply to a message that merely *looked* like an injection permanently marked that customer, with no send and nothing in the inbox to explain it. The flag write now sits inside the `!draft` guard alongside the `chatbot_unavailable` send. Drafting reads the customer and calls the model; the only writes it is allowed are the circuit breaker's success/failure record and its API-error push, which are infrastructure state, not customer state.
- **The honorific lives in a `greeting` variable, never in the string around it.** `` `Halo kak ${firstName}` `` with a `|| "kak"` fallback prints "Halo kak kak!" for every customer we have no name for. That shipped in six payment messages between 2026-08-19 and 2026-08-25; `extract-order.ts` was fixed then, but four other send sites kept the old shape until 2026-08-26 — the payment-verified message in `orders/route.ts` and in `assistant/execute/route.ts`, the cancellation message, and the Assistant's `send_payment_details`. Build `const greeting = displayName ? \`kak ${displayName}\` : "kak"` and interpolate that alone. `test/greeting-honorific.test.ts` fails the build if any send site regrows the old shape.
- **Never claim an order is recorded without calling `extract_order` in the same message, and never re-confirm an address already on the customer record.** Febby was quoted 30 porsi at Rp 810.000, told "sudah tercatat", asked whether her address was still the same, and no order was ever created.
- **An address sent as a photo is an address.** The model never sees images, but the admin does — the photo is in the inbox. The bot records `Alamat dikirim sebagai foto - lihat inbox` and creates the order rather than asking the customer to retype it; Fahmi was asked to type his out again and his Rp 540.000 order was never created. This is enforced, not only asked for: `recoverOrderFromConversation` substitutes that same pointer when extraction found no address text and the customer sent an image or document in the window, because otherwise recovery refuses on the `address` gate for exactly the customer who *did* supply one. A replay on 2026-08-19 quoted Fahmi 20 porsi at Rp 540.000, took his address photo, and still created nothing.
- **"20 hari dinner" is 20 portions, not a question.** A day count with one meal a day is a portion count; an end date mentioned earlier that disagrees does not make it ambiguous. Fahmi said "20hari dinner aja kak" on 2026-08-03, was asked twice whether he meant days or porsi, and his Rp 540.000 order was never created.
- **A dropped `package_size` is recovered by re-reading the chat, not by flooring.** Flooring to the smallest tier creates a real order for the wrong package, and that order then blocks the promise recovery that would have built the right one — Nadya agreed to 20 porsi at Rp 540.000 and was billed Rp 145.000 for 5. `applyLatestCustomerSize` (`src/lib/claude/extract-order.ts`) re-runs the forced-tool extraction when the size is missing, and otherwise lets the customer's last stated bare total override the model's: Tiwi was quoted 5, then 8, wrote "Boleh 6 porsi dulu kak", and the tool fired with 5. It reads only the final inbound message and only a bare total — "1 porsi per pengiriman" describes a delivery, not an order. Webhook paths only: on the admin inbox an admin has already read the size in the review modal and their number wins.
- **A top-up is a new order.** "Mau tambah 30 porsi" needs nothing from the package already running; asking what is active or how much is left is how Febby's add-on died in a clarification loop. A quota question asked in the same breath is answered separately and never holds the order — replayed on 2026-08-19 the bot answered "izinkan saya cek dulu ke tim" to both the quota question and the 30-porsi top-up for three turns, and the Rp 810.000 order was never created.
- **Extraction falls back to the address on the customer's record.** `extractOrderFromConversation` reads the chat alone, and a returning customer never retypes their address — the prompt tells the bot not to ask again — so extraction returns none for exactly the customers we know best, and both webhook recovery paths gate on having one. It now fills `address` / `area` / `sub_area` from `customers` when the chat carried none. For the same reason `createOrderFromExtraction` no longer writes those three columns when the extraction has no address: it used to blank the record of a customer we had been delivering to for months.
- **"Alamat sama seperti sebelumnya" is not an address.** Those same guards only ever checked that the address was *non-empty*, and the chat of a customer who was told not to retype theirs contains a sentence saying it has not changed — which extraction paraphrases straight into the `address` field. Julian S renewed on 2026-08-30 and his record's `Apartment Brooklyn AlamSutera Unit A17F` was replaced by `Alamat sama seperti sebelumnya (diantar ke atas)`; that is what the Dapur 1 sheet printed as the place to take his food. `isAddressPlaceholder()` (`src/lib/claude/extract-order.ts`) matches the back-reference openers — `alamat sama`, `masih sama kayak kemarin`, `seperti biasa` — under an 80-character cap, because a real address may well begin "Sama Residence" and one that long is a real address whatever it starts with. `createOrderFromExtraction` drops such an address before anything reads it, so every downstream "only when this order carried one" guard keeps what the record already holds.
- **Which dates are libur is never an escalation** — the list is already in the prompt under "Upcoming closures". Nadya asked whether 17 and 25 Agustus were closed, was told the team was being consulted, and the order she had asked to pay for was never created.
- **A renewal needs nothing from the package that came before it.** What the customer bought last time, on what schedule and at what price is in the conversation and on their record, so it is never an `ask_admin_for_help`. Julian S said "mau ambil yg 5 ka, tf kemana kaa?" on 2026-08-04, was told "aku cek dulu detil pesanan sebelumnya ke tim ya" three turns running, transferred anyway, and no order was ever created.
- Relative date phrases ("senin depan", "besok", "lusa") must resolve to the nearest upcoming occurrence from Today, not one cycle further out; an explicit date the customer states later always overrides the bot's earlier interpretation of a relative phrase — the bot must never silently "correct" a date the customer already confirmed.

## Weekly menu

- **Which week an image covers is stored, not inferred: `subcontractors.menu_week_start`** (migration 066), the Monday of that week. Nothing recorded it before, so the prompt and the `send_menu_image` tool description both flatly asserted the stored image was always the *current* week — false from the moment the next batch is published. On Saturday 2026-08-15 Vania asked for next week's menu while Batch 50 (17–22 Agustus) was already uploaded; the bot told her it wasn't out yet and to come back Friday, and Agnes sent it by hand.
- Publication is nominally Friday but not reliably so — Batch 50 went up on a **Thursday**. `defaultMenuWeekStart()` (`src/lib/menu/week.ts`) therefore defaults Thursday-onward uploads to next week, and that is only a default: the value is editable on the subcontractor form ("Menu week"), because whoever uploads the image is the only one who actually knows. Never re-derive the week from `updated_at`.
- **A week is always named to the customer as its full Senin–Sabtu span**, via `formatMenuWeekRange()` ("Senin 17 – Sabtu 22 Agustus 2026"). The prompt used to interpolate the bare Monday, and the bot echoed that single date as the extent of what it held: "Baru sampai minggu depan (Senin, 17 Agustus)" on 2026-08-16, for an image covering 17–22 Agustus. Each branch also states the span explicitly and tells the model never to give only the first day.
- `describeMenuWeek()` turns the stored date into `current` / `next` / `past` / `unknown` relative to today (Jakarta), and `describeMenuWeeks()` collapses the active kitchens — **any disagreement or missing value yields `unknown`**, which tells the bot to make no claim about which week it holds. The prompt has one branch per relation: send it as next week's when it is next week's, refuse-and-say-Friday when it is genuinely only the current week, `ask_admin_for_help` when stale or unknown.
- Asked about next week's menu before it is out, the bot says it isn't up yet and goes live Friday. It must never send an image as a week it does not have — on 2026-08-13 it answered "menu minggu depan udah ada kak" while attaching Batch 49 (10–15 Agustus, the current week).
- **The week after the one on file is named and refused explicitly.** The prompt's every branch ends with the span `weekAfter()` produces ("minggu depannya lagi", "dua minggu lagi", Senin 24 – Sabtu 29 Agustus 2026) and the instruction not to answer it with the image on hand. Without it the bot treated "minggu depannya lagi" as a synonym for next week and offered Batch 50.
- **A menu question is judged by the dates it covers, never by the word it uses.** Every rule in that block was week-shaped, and customers do not ask in weeks: on 2026-08-31 Cindi asked *"kak menu bulan september apa ya??"* while the image on file was Batch 51, Senin 31 Agustus – Sabtu 5 September — five of the days she was asking about. The model matched "September" against the week label, missed, fell into the week-after rule and answered *"menu September belum terbit belum kak"*, then offered her "menu minggu ini" as if that were a different menu. `beyondRule` now states the boundary as a **date** (`menuWeekLastDay()` → "Sabtu 5 September 2026") rather than as the next week's label, and says outright that a question about a month reaching into the span is already answered in part: name the dates we do have, offer them, and call unpublished only what falls past that Saturday.
- **`send_price_list` exists because the welcome sequence was the only thing that ever sent the price list.** The image goes out once, at first contact (`route.ts:1440`), and until 2026-08-31 no tool could resend it — the bot's registry had `send_menu_image` and nothing for harga. Cindi asked "boleh kirim ulang price listnya kak?" on 2026-08-31 and was told *"sayangnya untuk saat ini saya nggak bisa kirim gambar price list dari sini 😅"*, which was true, and then *"nanti tak kirim gambar price listnya ya"*, which nothing was going to do. The tool reads `settings.price_list_image_url` and sends it; **it refuses for a customer with `contract_price_per_portion`**, because a negotiated rate replaces the ladder and the image would be the wrong prices — the prompt already said not to send it, and the handler is the half that holds when the model forgets. An unset URL is an error the model is told to answer by typing the prices, never by promising an image.
- `send_menu_image` sends every **active** kitchen's image. The `is_active` filter is load-bearing: inactive kitchens keep a stale `menu_image_url` indefinitely, and without it the same reply carried Batch 49 and Batch 39 (1–6 Juni) from a kitchen retired in June.
- **`send_delivery_proof` answers "bukti pengiriman" with the photo, and it goes free-form, not as the template.** The Proofs tab fires unprompted, so it must use the `delivery_proof` template — and a template is exactly what `131042` blocks once a customer's window has closed. This tool only ever runs because the customer just messaged us, so the window is open by construction and the photo goes as a plain image. That is also the whole point of asking a silent customer to write in first: of the 30 proofs sent 20–31 Agustus, all 12 to customers who had spoken within 24 hours landed and all 18 to customers who had not failed. The photo is found by `delivery_proofs.matched_customer_id` — `matched_delivery_id` and `daily_deliveries.delivery_proof_id` are NULL on all 587 rows, so the customer is the only join that exists, and an optional `date` filters on `received_at` (the day the kitchen sent it to us). No photo returns an error naming the date, telling the model to say so and offer `ask_admin_for_help` — never to promise one is coming. The send is logged to `edit_log` as `resend_on_request` rather than written onto the proof row, which keeps the record of the original push.
- **The model must never see a media URL as message text.** Every image we send is saved to `conversations` with the raw file URL as its `content` — the inbox renders from that. `loadHistory` fed it back verbatim, so the model's own history contained assistant turns that were nothing but a Supabase storage link, and on 2026-08-16 it copied the pattern: "Tentu kak, ini dia menu untuk minggu depan ya:" followed by the bare URL as text, with no `send_menu_image` call. The customer got a link to open by hand. `historyContent()` (`src/lib/claude/conversation.ts`) now replaces the content of an `image` / `document` row with a placeholder **only when the content is itself a bare link** — captions, `[Bukti pembayaran dikirim]` labels and maps pins pasted as text messages must survive, since the order form is filled from them. The prompt rule ("never write an image URL or any link") is the second layer, not the fix. **The placeholder is tagged `[sistem: …]` for a reason** — as a bare bracketed phrase it read as assistant prose and the model started writing it itself in place of calling the tool, which is the 2026-08-26 incident under "The bot must not claim it sent the menu without sending it". Never quietly shorten it back.

## Confidentiality flow for subcontractor issues

When subcontractor is unavailable, use template: "Halo kak, mohon maaf dapur partner kami yang biasanya besok libur, besok kita akan kirim dari dapur yang satunya lagi"

## A pending admin question no longer silences the bot

`ask_admin_for_help` sets `pending_bot_response: true`, and the webhook used to treat that flag exactly like a takeover: save the inbound message, push, return. One escalated side question therefore ended the conversation — every later customer turn went unanswered until an admin cleared the flag by hand, which is human action inside the order-creation workflow. Replay on 2026-08-18 lost two orders to it outright: Tiwi asked whether delivery could arrive before 10.30, PT Bintang Lautan asked about PPh withholding, and everything after — address, portion count, "mohon kabari nomor rekening" — hit the dead branch.

The branch is gone. The flag now only shapes the prompt: `pendingAdminQuestion` is read in `processSavedCustomerMessage` and rendered as a section telling the model not to answer that one question, not to re-ask it via the tool, and to keep taking the order. Admins still get a **high**-priority push on every new message while a question is open, and `pending_bot_question` still drives the inbox draft flow, so nothing is lost on the admin side. The hallucination validator's park (two rejected drafts) writes the same flag and is un-blocked by the same change — it retries on the next message instead of parking forever.

The prompt's Escalation section now states the rule directly: escalating never replaces creating the order, and total portions, prices, off-list sizes, package days, delivery area, Catatan notes and schedule/quota mismatches are never escalated at all.

## An escalation the bot claims is one it never made

"Perlu saya cek dulu ke tim" with no `ask_admin_for_help` in the same response is a dead end: nothing is written to `customer_flags`, no admin is pushed, and the customer sits waiting for an answer to a question nobody was ever asked. Same failure class as `ORDER_PROMISE` and `MENU_SENT_CLAIM` — a claim the model makes instead of calling the tool — and it was the only one with no enforcement. `system.ts` forbids it only when the message *also* contained order details, so a pure question fell straight through.

A C4 ad lead (`+6287812476058`) is the case. He asked one answerable question on 2026-08-20 — what a no-rice portion contains and what it costs. Turn 1 answered the spec correctly from the prompt's own rule and then withheld the price, which does not depend on the no-rice option at all and was already on the price-list image sent four minutes earlier. Turn 2 retracted the correct answer, claimed to be checking with the team, and re-asked a question he had just answered. `escalated_to_human: false`, `pending_bot_response: false`, `pending_bot_question: null` — no admin ever saw it. He wrote "Batal..ribet 😏" nine minutes after his first message. Nobody had told him the minimum order is 5 porsi.

`ESCALATION_CLAIM` (`src/app/api/webhook/whatsapp/route.ts`) matches a check verb near an **addressee** — tim / admin / dapur / partner / atasan / kantor / rekan. The addressee is what separates a claimed escalation from the model stalling on its own arithmetic: "perlu saya cek dulu sesuai total porsi" names nobody and does not match. On a toolless reply that matches, `recordClaimedEscalation()` writes `pending_bot_response` / `pending_bot_question` and pushes admins at **high** priority, using the customer's own message as the question — it is what an admin has to answer anyway. It deliberately does **not** route through `handleToolUse`: that path also sends "Mohon tunggu sebentar kak, kami sedang cek dulu ya", which is what the reply already says, and the customer would get it twice. Skipped when a question is already open, so a customer chasing an unanswered one does not re-push every turn.

This parks the thread for an admin; it does not silence the bot (see the section above). Recovering the lead itself is still human work — the durable fix for that half is answering the question in the prompt, not escalating it.

## `createOrderFromExtraction` checks its insert, and fills the two fields the model drops

The `orders` insert discarded its error. A model that omits one required field (Nadya's replay dropped `package_size`) produced a rejected insert, an undefined order row, no deliveries, and then a crash on `input.customer_name.split(" ")` — with the customer already told the order was placed and nothing anywhere recording the failure. The insert error is now logged, pushed to admins at **high** priority, and thrown.

Two inputs are also defaulted rather than trusted. `orders.start_date` is NOT NULL and a renewal usually carries no date — Julian S said "mau lanjut 5 porsi lagi", got the transfer details, paid Rp 145.000, and the order never existed; it now falls back to the next day we deliver (Senin–Sabtu, skipping libur nasional). And `customer_name` comes back as the literal string `"unknown"` when the customer never typed a name, which was written to `customers.name` and greeted the customer as "kak unknown" — that value is now discarded on both the record and the message.

## A payment proof with no order behind it now creates the order

A customer who transfers before the bot ever called `extract_order` used to leave the money nowhere: `shouldHandlePaymentProof` needs a `pending_payment` order, so with no order at all the slip was saved as an ordinary inbox photo and the bot asked for the summary to be confirmed again. Theresia agreed to 5 porsi on 2026-08-03, sent the slip, and nothing recorded a purchase.

The webhook now runs the same forced-tool `extractOrderFromConversation()` the admin inbox uses when an image arrives and the customer has **no order in any status**, creates the order with `sendPaymentInfo: false` (they have already paid), then falls into the normal proof handling so the order advances to `payment_proof_received`. Extraction returns null when the chat never contained an order, and the create is gated on `package_size > 0 && address`, so a photo from a browsing customer still creates nothing. Admins get a **high**-priority push either way.

## The days are required, and nothing infers them

`delivery_schedule` is a **required** field of `extract_order`, and `[]` is the answer for a customer who books day by day. A call that omits it is refused outright: `createOrderFromExtraction` writes nothing, sends no bank details, asks the customer which days they want, and lets the model call again next turn — the same shape as the name guard, and for the same reason. Creating the order is what asks for money.

This replaced a ladder of inferences (2026-08-28). `createOrderFromExtraction` used to guess a meal preference three ways — inherit the customer's previous standing pattern, downgrade an unsupported `both_fixed` to `lunch_only`, promote a `per_day_decision` the customer's own words contradicted — and a stated duration in weeks or an end date was read as a standing block and filled with `lunch_only`. Every one of those existed to answer a question the model was not being made to answer, and each turned into dates: a whole week of deliveries built out of an enum. galvent's is the case that made it visible — "Jdwal tdk menetap", one day asked for, five booked.

What survives is the arithmetic that needs no schedule: `statedWeeks()` still reads "2 minggu" as 10 portions, because a duration is a **size** for a customer who named no days, and Lina Marlianty's 10-porsi order is why. `portions_per_delivery` is a required field and is now the source for one day's portions — the enum it replaced could only ever say 1 or 2.

## A payment-date question is answered, not escalated

"Bayar tanggal 1 bisa nggak kak?" got "saya perlu konfirmasi ke tim admin dulu" on 2026-08-21, from a customer whose package starts 2 September. Nothing expires a `pending_payment` order and no rule requires paying on the day of ordering, so the answer was yes and the bot had everything it needed to say so. The cost is not the wrong answer, it is the park: `customer_flags.pending_bot_response` went true, the bot then refused to answer anything else on the thread, and it stayed that way until a human cleared the flag by hand. The existing escalation rules only covered a side question asked *alongside* order details — this one was the whole message, so nothing caught it.

The prompt now answers payment timing from the order's own dates and escalates only a payment question about something we do not offer (cicilan, faktur, a channel other than transfer).

## A dapur the model omits is resolved, not left null

Cindi's order was written with `subcontractor_id` null, and 33 open orders carry one. A null kitchen is invisible on `/dapur/[id]` and on the kitchen's own sheet — both filter strictly on it — so the food is never cooked and nothing says why. The tool lists `subcontractor_id` as required whenever a dapur has a menu uploaded; the model omits it anyway, and `required` is not enforced.

`createOrderFromExtraction` now falls back the way an admin would: the kitchen the customer already buys from, then the only active kitchen whose `delivery_areas` covers the order's area. Two candidates is a genuine choice between kitchens and stays null.

The backlog was cleaned up on 2026-08-22 only as far as it was actually breaking something. **Of every future `daily_deliveries` row with a null kitchen, all 12 were Cindi's**, so her order (`1e331e01`, Karawaci — one covering kitchen, no judgement call) and those 12 rows were written to Dapur 1 by hand, guarded on `.is("subcontractor_id", null)` and logged to `edit_log` as `system:assign-kitchen` with the reason. **32 open orders still read null and are deliberately untouched**: none of them has a future delivery row, so none is invisible on a kitchen sheet, and 4 of them are a real choice between the three kitchens covering BSD Baru/BSD Lama that no fallback should make silently. The count and the buckets are in the queue (`pnpm tasks`). Assigning a kitchen to an order that has no rows yet buys nothing and guesses on the customer's behalf.

## A split-address order carries the slot, instead of promising an admin will set it

The bot has been telling customers yes to "makan siang ke kampus, makan malam ke kost" since the prompt first mentioned it — and `createOrderFromExtraction` wrote `address_slot: 1` on every row it created, hardcoded in three places (the derived recurring rows, the rows built from a model-supplied `delivery_schedule`, and the `fillMissingSchedule` backfill), with `lunch_address_slot`/`dinner_address_slot` never set on the order at all. The kitchen sheet showed one address for both meals, and nothing anywhere said the promise had been dropped: the columns, the sheet's slot-2 rendering and the order modal's toggles had all existed since migrations 044/048, and only the bot's own path ignored them. Cindi asked for exactly this on 2026-08-21 — dinner to her kost in Karawaci, lunch to UPH — and the order created that evening books both meals to the kost.

`extract_order` now takes `address_2`, `area_2` (same served-area enum as `area`), `sub_area_2`, `maps_link_2` and `address_2_meal` (`lunch` | `dinner`). The order stores the two slots, every delivery row stamps its slot from its own `meal_type`, and the second address is written to the customer record under the same rule as the primary one — only when this order actually carried it, so a renewal extracted from chat alone cannot blank it. A slot 2 is only assigned when there is an address to put in it, from this order or already on the record; `address_2_meal` alone sets nothing.

**This is the standing per-meal split only.** A one-off day at a different address is still a per-day flip on the daily sheet, and the prompt now names the two shapes separately so the bot stops routing a standing split through "nanti admin set".

## The bot is told the time, not just the deadline

The prompt used to state the calendar date and the order cutoff hour and stop there — no clock. Given "Order deadline tonight: 16:00 WIB" and nothing to compare it against, the model read the cutoff as permanently still ahead. On 2026-08-20 at 19:05 WIB, three hours past it, a new customer asked to start "besok mksnya, kan Jumat" and was told "Oke kak, mulai besok Jumat ya" with a price and a schedule. Nothing was booked — no order existed yet — but had they transferred that night we would have owed a delivery the kitchen had already been closed out for.

`buildSystemPrompt` now computes the comparison instead of leaving it to the model (`src/lib/time/jakarta.ts`). The context block carries the WIB wall clock, and one of two cutoff lines: cutoff still open with the soonest deliverable date, or **SUDAH LEWAT** with an instruction not to offer, change or skip tomorrow and the next date that may be promised. `earliestDeliveryDate()` does the arithmetic — day after tomorrow once the cutoff passes, then forward past Minggu and any libur nasional — so the model quotes a date rather than deriving one. Same cutoff governs changes and skips, not just new orders.

The date line had a second defect fixed in the same change. It was built with `toLocaleDateString("id-ID")` and no `timeZone`, and Railway runs UTC, so between 00:00 and 07:00 WIB the prompt asserted yesterday's date. It now uses `jakartaDateString()`.

**Known gap, 2026-08-24:** being told the cutoff has passed is not the same as acting on it. Julian S asked to skip tomorrow at 18:33 WIB on 23 Agustus, well past 16:00, and got "kemungkinan sudah lewat ya kak" plus an escalation — the prompt held the answer and the model parked it anyway, because skips and cutoff questions are missing from the never-escalate list and `ask_admin_for_help` is described as the default for any uncertainty. Queued in the `tasks` table.

## The bot reads the schedule from the database, not from the chat above it

Nothing in the prompt ever said what a customer actually had booked, so the model reconstructed it from the conversation — where a one-off change made for a date that has since passed still reads as current. On 2026-08-20 it told Nadya "pesanan besok dikirim siang jam 10.00-12.00". That was her 19 Agustus request, which applied to the 20th. Her 21 Agustus row had been `dinner` since the 18th. She believed the bot, asked to move it to malam, and the bot "confirmed" a change nobody needed and nobody made — while quoting her the 16:00 rule in a message sent at 21:24 WIB.

`loadCustomerSchedule()` (`src/lib/orders/customer-schedule.ts`) now supplies a **Jadwal pengiriman customer ini** block: every booked delivery from today forward with its date and meal, plus both quota numbers, and an instruction to answer schedule questions from that list and not from the chat history. It also tells the model to name the exact date and meal back when confirming a change, so a customer whose record already matches their request learns nothing needs changing.

The two quota numbers are stated separately and deliberately — `remainingToday` (paid for, not yet delivered) and `unbooked` (not yet on the calendar). Both are counted from the delivery rows; `orders.portions_remaining` cached the second one and was dropped in migration 075. Quoting `unbooked` as the balance tells a customer with twelve meals coming that they have none; see the "Sisa kuota" rule in `OPERATIONS.md`.

## An event order is gathered, not priced — and never billed early

A one-off event (a single date, a box count, no subscription) is priced by tendering it to the kitchens, never off `pricing_tiers`. The bot's job ends at collecting the brief: budget ceiling, what goes in the box, date, portions, meal time, area and address, drop-off window. It confirms that brief back to the customer and hands off to an admin. It does not name a per-portion price, and it **does not call `extract_order`** — creating the order is what sends the bank details, so an early order is an early bill.

On 2026-08-25 a lead asked at 08:08 for 40 porsi makan siang in Gading Serpong on 22 September, budget under Rp 30.000. At 08:10 the bot had created the order and sent BCA details for a total nobody had agreed, having never asked what should be in the box. The customer asked for the menu twice and then "18 rb itu dapat apa saja" — a number the bot had invented and so could not defend. It stalled at 08:18 and the thread died with a payment request in it.

The ordinary package path is different on purpose: a subscription is sellable the instant a size is named, which is why `extract_order` fires early there. The distinguishing question is whether a kitchen has to bid before we know the cost. If yes, gather and escalate; never quote, never create.

See "A custom/event order is tendered to the kitchens" in `OPERATIONS.md` for the full operational sequence.

## Tanpa nasi is free, and saying otherwise loses the customer

`system.ts` lists four accepted custom requests but the header said "exactly three exceptions", and item 3 (*tidak ada nasi*) named the +25% protein compensation without ever saying what it costs — directly above item 4, which carries an explicit +Rp 5.000 nasi merah surcharge. The model read the pair the only way it could and hedged on price. On 2026-08-20 two unrelated customers asked for tanpa nasi within two hours; to the first (`+6287812476058`) the bot said "perlu saya cek dulu ke tim terkait macam lauk dan harganya" and asked for a portion count instead, and the customer left with "Batal..ribet". There is no tanpa-nasi rate anywhere in the code — `getExtractedOrderPricing` takes only `nasiMerah`, and `NASI_MERAH_SURCHARGE` is the single add-on — so the price is simply the normal ladder. Item 3 now says `harga sama, tidak ada biaya tambahan` in the instruction and in the sentence the model is given to say, the header counts four, and the decline line lists all four rather than omitting nasi merah.

**"Lauk only" is this exception under another name, and the model did not recognise it.** The rule was keyed on the literal words *tidak ada nasi* / *tanpa nasi*, so a customer who phrased the same request as "hanya lauknya" fell straight through to the generic decline line. On 2026-08-26 `+628129423509` asked "kl hanya lauknya bisa kak ?" and the bot answered "untuk saat ini kami hanya melayani paket lengkap ya … kami belum bisa melayani lauk saja", then recited "nasi + lauk + sayur + sambal" — contradicting the exception one paragraph above it in its own prompt. The lead replied "oke .makasih ya" and left. `paket lengkap` appears nowhere in `system.ts`; the model invented it to justify a refusal the rules never asked for. Item 4 now names the phrasings ("hanya lauknya", "cuma lauk", "lauk saja", "lauk doang", "tanpa nasi aja", "no rice"), says the sayur and sambal stay, and forbids the complete-package answer outright. Note this is the *second* distinct way this one exception has lost a lead — the first was hedging on price, this one is not recognising the request at all.

**The list is five, not four: *tidak ada seafood* is a protein substitution, not an allergy request.** Seafood is swapped for chicken exactly like beef, and the prompt was missing it entirely while the price list image had carried `TANPA SEAFOOD` on the protein card all along. Item 3 now states it, and says in as many words that it must never be folded in with tanpa susu / tanpa kacang, which we decline.

**Allergy requests are declined, and the reason is said out loud.** Everything is cooked in one shared kitchen, so "bebas dari X" is not something we can guarantee. The prompt now gives the model the sentence — "masakannya dibuat dalam satu dapur bersama, jadi kami belum bisa menjamin bebas dari bahan tertentu" — rather than leaving it to invent a bare no.

## The validator's retry told the bot to stall, and to forget the price list

When `validateReply()` rejects a draft, the webhook asks the model to rewrite it. That retry instruction used to read: *"hanya gunakan fakta dari Current context di system prompt. Jika data tidak tersedia, katakan akan dicek dulu."* Both halves were wrong.

"Only Current context" is **narrower than the validator's own rule**, which says in as many words that it does not flag business info. Current context holds this customer's row — name, quota, order status — not the pricing ladder and not the custom-request exceptions. So a retry stripped the model of facts it legitimately had. On 2026-08-26 `+6287895957020` was told tanpa nasi costs the same (correct, per exception 4), and then, after a retry, that the price "belum saya pastikan ... ini saya cek dulu ke tim ya kak" — about a rate that does not exist anywhere to be checked. The customer answered "Pastiin dulu aja harganya kak, takutnya gak cocok" and the thread stopped on a Rp 145.000 order that was already fully specified.

"Katakan akan dicek dulu" is the worse half: nothing schedules that follow-up, so it instructed the bot to make a promise the business cannot keep. It is the exact shape `/api/cron/stalled-leads` now has to detect after the fact — the prompt was manufacturing the stalls the cron job exists to clean up.

The retry now says: fix only the flagged claims and leave the rest alone; business rules in the system prompt stay fully usable and only this customer's personal data may not be guessed; and if that data is unknown, **ask the customer** rather than promising to check with the team.

## 5 and 6 days are the common weeks, not the only packages we sell

The price list section said "Fixed weekly orders are available 5 days (Senin–Jumat) or 6 days (Senin–Sabtu)", and the worked examples all used 5 hari. The model read the pair as the permitted set and began refusing anything else — a customer asking for a 7-day run was told we only do 5- or 6-day packages, which is not a rule that exists. The ladder in `pricing_tiers` is priced on **total portions** (5 → 144), never on a number of days, and `extract_order` already accepts an arbitrary date set with gaps.

Both places now say 5 and 6 are the commonest shapes rather than the menu, that any run is sellable as long as every date falls Senin–Sabtu and is not a closure, and that a run containing a Minggu or a libur is answered by naming the closed dates and offering the rest — not by refusing the package. This also removes the framing that had the bot calling Sabtu closed and then correcting itself: the line now leads with "Dapur kami delivers Senin–Sabtu".

**A date range is not a day count.** The prompt now says so where the closures list is described: check every date in a run the customer names against the list, drop the closed ones, say back how many delivery days are left and which dates were dropped, then multiply porsi per hari by *that* number. Julie asked for 1–7 September on 2026-08-29 and was quoted "7 hari, dengan 2 siang + 2 malam per hari = 28 porsi" at Rp 728.000, twice, once as a confirmation question. 6 September is a Minggu; the run is 6 hari, 24 porsi. The old prompt had the rule for the *booking* call ("skip Minggu" in `record_daily_order`) but nothing for the arithmetic the model does out loud in the quote, which is what the customer actually agrees to — and by the time the tool drops the Minggu the price has already been said. Both halves of the fix are in `buildSystemPrompt`: the closures list carries the Minggu (see `describeUpcomingHolidays()` in `docs/OPERATIONS.md`) so the check is a lookup, and the counting rule names the range case explicitly.

## Never deny something printed on our own price list

The price list image is a copy of the accepted-request list that the model cannot see, so when a customer quotes it back there is nothing for the model to check it against — and its instinct is to disown it. On 2026-08-22 a lead read `TANPA SUSU` off the image (V2 carried a `REQUEST ALERGI` card) and asked about it. The bot answered twice that "request susu itu bukan dari kami ya kak — bisa jadi dari layanan lain", telling a customer that our own artwork belonged to another company while they were looking straight at it; the lead pushed back with "Ini kan ada requestnya." and the bot repeated itself. The prompt now forbids attributing a named request to anyone else: say whether we serve it today, and treat the image as the thing the customer is holding.

That is the customer-facing half. The other half is that the image drifts, because nothing reads it — see "Pricing" in `OPERATIONS.md` for the rule that it changes in the same session as the prompt.

**Still open: an accepted custom request has nowhere to live.** The section is headed "Catatan field" and tells the model to "note it in the order", but `extract_order` has no notes parameter and `orders` has no notes column — only `daily_deliveries.notes` (per-row, admin-typed) and `customers.notes` (internal, holds learned context). So tidak pedas, tidak ada daging sapi and tidak ada nasi are confirmed to the customer and then dropped; the kitchen sees them only if an admin retypes them onto each delivery row by hand.

## An accepted custom request now reaches the kitchen, in `catatan`

Agreeing to "tanpa nasi" in the chat used to be the whole of it. `extract_order` had eighteen fields and the only rice one was `nasi_merah`, a *paid* upsell — so the prompt told the model to accept the request and never stall, then gave it nowhere to record what it had promised. Nothing that materialises a delivery row writes a per-row `notes`, so every delivery row landed `notes: null`. On 2026-08-25 Surya ordered 15 porsi tanpa nasi and all five rows were blank; the kitchen would have cooked rice for the lot if an admin had not typed the note into `customers.notes` by hand.

`extract_order` now takes `catatan`, and the prompt requires the accepted requests (items 1–4 — tanpa nasi, tidak pedas, tidak ada daging sapi, tidak ada seafood) to be passed in it. Nasi merah stays in its own field because it moves the price.

It is written to `customers.notes` by `mergeKitchenNote()`, not to the delivery rows, because these are standing preferences — they apply to every delivery of the package, and a per-row copy would have to be rewritten on every amendment. The kitchen sheet prints `manualNotesOnly()`, everything *before* the `[AI learned context]` block, so the merge always puts the note above that block: the sheet is unauthenticated and the block carries prices, so anything that pushed the block up would leak them. The merge is a no-op when the request is already in the manual text, because `extract_order` re-runs on every amendment and renewal and an unconditional prepend would stack the same line until it pushed the drop-off instructions off the sheet.

**The sheet prints the note as two boxes, not one: `Makanan:` and `Pengiriman:`.** One field, two audiences — the cook acts on the diet, the courier acts on the handover. Julian S's card read *"Preferensi: Makanan diantar ke atas (lantai atas) tidak ada kacang dan bawang goreng titip dibagian drop off info aja kepetugasnya kalo makanan ini diantar keatas"*, in which the only thing the kitchen has to act on is the middle third of a paragraph about stairs. `splitPreferences()` (`src/lib/kitchen/preferences.ts`) partitions the already-filtered string clause by clause: a clause naming the handover — where it goes, who takes it, what to do on arrival — is a delivery instruction, and everything else is food. It **partitions, never filters**, and food is the default side, because a dietary request in front of a courier is noise while a dietary request the cook never sees is the wrong meal.

**This does not replace the summarizer's `Preferensi:` bullet, and neither covers the other.** `aiPreferences()` is only consulted when there is no manual note at all, so a customer with any manual note falls back on `catatan` alone — and customers whose context was summarised before 2026-08-25 have no labelled bullet anyway. Both paths write; the sheet reads whichever it finds first.

## The kitchen note carries the customer's request, never our answer to it

**"Protein +25%" must never appear in a kitchen note, in any wording.** Tanpa nasi bumps the protein portion by 25%; that is our arrangement with the kitchen — an operational and commercial term — and it reaches them through their rate and their brief, not through a customer's record. Written on the sheet it states an internal term as if the customer had asked for it, on a page that is unauthenticated and shared with the subcontractor. The sheet already refuses to print prices for the same reason.

It got there because the sentence the bot is told to say to the customer contains it ("porsi protein kami tambah 25% sebagai gantinya"), so both writers copied it across: `learnCustomerContext` put "tanpa nasi (protein +25%)" into six customers' `Preferensi:` bullets, and `catatan` would have carried the same phrasing into every new order.

Both writers are now told not to, and `stripCompensation()` (`src/lib/kitchen/compensation.ts`) enforces it at both ends — on write in `mergeKitchenNote()`, and on render in `kitchenPreferences()`, which covers the summaries already in the database. It **strips, never drops**: the compensation is usually a parenthetical hanging off the request itself, so removing the clause would take "tanpa nasi" off the sheet with it. A customer's own request for extra protein has no percentage in it and is left alone.

The same strip-don't-drop rule now applies to prices: `usefulClauses()` used to discard the whole clause when `MONEY` matched, so "tanpa nasi (harga tetap sama)" cost that customer their dietary request. The parenthetical is removed and what remains is judged on its own; a parenthetical that is not about money ("(diganti ayam)") is untouched.

## "Nearest served area" has a floor, and it is the kabupaten

`Area never blocks the order` was written for the opposite failure. The
neighbourhood lists injected into the prompt are clusters, not the whole map, so
an address fragment the bot does not recognise usually means we *do* serve the
place — Janice's "Pagedangan" was asked about four times running on 2026-08-10
and her order was never created. The rule therefore says: if nothing matches,
ask once, then pick the nearest served area yourself and create the order.

It had no floor. An address genuinely outside coverage took the same path.
Sarah Sinaga gave "Serpong Natura City Cluster Riverside, Jalan Raya Serpong,
Gunung Sindur (Blok NRS 2 No. 58), KAB. BOGOR" on 2026-08-30 and shared a pin at
-6.36135, 106.68559. The word "Serpong" in the cluster name was enough for the
matcher; nobody checked the kabupaten. She was quoted **Rp 1.040.000** for 40
dinner portions, Senin–Sabtu for 20 days, to an address no active kitchen
delivers to, and told "saya lanjut buatkan ya". Only the separate `extract_order`
failure kept it from becoming a real order — the quote had already gone out.

The rule now distinguishes the two cases by administrative region: an
unrecognised *cluster* still rounds to the nearest served area, but an address
naming a different kota or kabupaten from the ones our areas sit in is outside
coverage, and no proximity of pin changes that. The bot says so plainly, names
the areas we serve, does not call `extract_order`, and escalates. Pinned by
"stops nearest-area rounding at the edge of coverage" in
`test/api/system-prompt.test.ts`.

**Check reachability before quoting, not after.** A price named to someone we
cannot deliver to is the part that costs a relationship — Sarah had already
filled in her name, her address, her maps pin and her schedule by the time the
figure appeared, and withdrawing it afterwards is a worse message than never
having sent it. The areas themselves are never literals here: they arrive from
`activeDeliveryAreas(db)`, so a kitchen going inactive narrows the check on its
own.

## A maps link is not an address the model can read

The floor above assumes the address arrives as words. Sarah Sinaga's second one
did not. Told her home in Kab. Bogor was out of coverage, she answered "ada
alamat kantor sihh kak" and sent a bare Google Maps link — nothing else, no
street, no area. The model cannot open a link, so it had no information at all
about where the pin was; it wrote `area: "BSD Baru"` and the address
`"Alamat kantor sesuai titik Google Maps yang dikirim"`, quoted **Rp 336.000**
for 12 portions and sent the bank account number, forty minutes after we had
told her by hand that we could not deliver to her. The office is also outside
coverage. The order (`5e0c623f`, `pending_payment`, no delivery rows) was
cancelled by hand and she was told a second time.

Two older rules combined into this. "Nearest served area" let it invent an area
when nothing matched, and "an address sent as a photo, a shared location or a
maps link still counts as given" — written so a customer who sent a pin is never
asked for their address twice — read as though the pin also answered the area
question. It does not. A link is what the courier needs *after* the area is
settled; it is never what settles it.

So: never fill `area` from a link, never write an address whose whole content is
"sesuai titik maps", and never quote a price or call `extract_order` on a
link-only address. Ask which area the place is in, in words, and wait. Pinned by
"does not let a maps link settle the area" in `test/api/system-prompt.test.ts`.

## A renewal is waiting on the days, and nothing else

`Quota exhausted` in the daily-quota block told the model to ask which days and
which meal "before you place it", and to call `extract_order` "only once they
have told you the days". Both sentences are gates. Neither is a trigger, and the
branch had nothing else in it, so the days arriving changed nothing.

Julian S asked to renew 5 porsi on 2026-08-30 at 07:10. By 07:14:51 he had given
the meal (dinner), the days (Senin–Jumat, "seperti biasa"), the start date
(31 Agustus) and a kitchen note (diantar ke atas), and had confirmed the address
was unchanged. The bot printed the package back at 07:12:29, again at 07:13:38,
again at 07:15:25 — "Sudah benar semua kan kak? Kalau iya saya buatkan ordernya
ya" — and at 07:15:50 said "Baik kak, saya buatkan ordernya sekarang ya kak"
with no tool call. `flagOrderAtRisk()` caught it as an unkept promise and pushed
to an admin; the order did not exist. He had renewed four times before, so
nothing about the request was ambiguous.

The rules that would have stopped it were all present — "Never ask for
confirmation twice", "An address already on the customer record is not
re-confirmed", "Never say an order is recorded unless you called extract_order
in that same message" — but they live in the sign-up flow section, and a
renewal reads as a different procedure. The branch now carries the trigger
itself: a returning customer's name, address, price and portions per delivery
are already on file, so the days are the only outstanding field and the turn
they arrive is the turn that calls the tool. Pinned by "a renewal whose quota is
exhausted" in `test/api/system-prompt.test.ts`.

The general shape is worth keeping in mind when editing this prompt: a rule that
only says when *not* to call the tool leaves the model with no moment at which
it must. Every gate needs the turn that opens it named alongside.

## A leftover porsi is spent before a new package is sold

Veronica Catherine asked for seven days on 2026-08-30 holding 1 porsi she had
already bought (38 bought, 37 drawn, no future rows). The bot named the leftover
to her in one message — "sisa 1 porsi ya kak" — and in the next sized the new
package at the full 7, which sells her that porsi a second time.

The daily-quota block only ever spoke to the two ends: quota exhausted (the
renewal branch above) and quota left (keep booking against it). A customer with
quota left but *less* of it than the run they want had no rule at all, and the
model treated the leftover as a separate thing to be used later rather than as
the first porsi of what it was quoting. The schedule block now carries the
arithmetic whenever `remainingToday > 0`: the new package is what they asked for
**minus** the leftover, "7 − 1 = paket 6 porsi", and the leftover keeps its own
price — it was bought at the old rate and is not re-quoted. Pinned by "a
customer whose leftover quota is smaller than what they want" in
`test/api/system-prompt.test.ts`.

**The leftover is spent on the calendar too, not just in the arithmetic.** A
6-porsi top-up with a 7-day schedule writes 7 rows at `mark_paid`, and those
rows used to be stamped with the new order: it sat 1 over its own package while
the older order kept a portion it had been paid for and could never complete.
Veronica's seventh row was repointed by hand. `mark_paid` now charges each row
through `pickDrawOrder()`, oldest package with balance first, so the leftover
porsi is drawn from the order that sold it — see "Marking an order paid never
regenerates a schedule it already has" in `OPERATIONS.md`. Still do not floor
the schedule at the package size: that drops a meal the customer paid for.

## 7 porsi is not a package, and the model may not invent one

The same thread produced a total we do not sell. The pricing rule — off-list
totals are billed at the rate of the largest listed size below, as long as the
total is a multiple of 5 or of 6 — is in the prompt with worked examples, and
the model applied the *pricing* half to a size the *sellable* half excludes:
7 is neither on the ladder nor a multiple of 5 or 6. Nothing downstream checked.
`createOrderFromExtraction` would have priced 7 porsi at Rp 29.000 and sent the
bank details for a package that does not exist.

The guard is now in code, immediately after `packageSize` is resolved and before
the open-order lookup that deletes `daily_deliveries` — so a rejected size
touches nothing. `isSellableSize()` is the ladder floor plus "multiple of 5 or
of 6"; `nearestSellableSizes()` finds the one below and the one above.

Two exemptions and one fallback, all deliberate:

- **A contract customer is exempt.** `contract_price_per_portion` replaces the
  ladder entirely, so their sizes are not ladder sizes.
- **`sendPaymentInfo: false` is exempt.** That path amends or backfills an order
  that already exists; refusing there would strand it.
- **Prefer the model's own `package_size` when it is sellable.** The refusal
  would otherwise loop forever on the very case that produced it: Veronica's
  schedule sums to 7 while the package she agreed to is 6. When the schedule
  total is unsellable and `input.package_size` is not, the stated size wins and
  the order is created.

Only when both are unsellable does the bot withhold the order and ask, in the
withhold pattern every other guard here uses (compose → `saveMessage` →
`sendTextMessage` → `updateMessageReceipt` → `NOTHING_TO_SEND`): "paket 7 porsi
belum ada 🙏 … Yang paling dekat: *6 porsi (Rp 174.000)* atau *10 porsi
(Rp 280.000)*". Both quotes are real, priced through `getExtractedOrderPricing`
at the size the customer would actually be buying. No order, no bank details, no
delivery rows. Pinned by `test/order-sellable-size.test.ts`.

## An order promised while quota is left is promised by nobody

Veronica agreed to the 6-porsi package and confirmed her address. The bot
answered "Aku siapkan sekarang ya kak", then "Nanti detail transfernya menyusul
ya kak", and called no tool. Payment details are composed and sent **only** by
`createOrderFromExtraction`, so nothing was ever going to follow — and no order
was created.

That is the Julian S failure again, and the rule written for it did not fire:
the renewal branch is gated on `remainingToday <= 0`, and her 1 leftover porsi
switched it off. `flagOrderAtRisk()` did not fire either, because
`customerStatedSize()` looks for a digit in the customer's *own* last 40
messages within 48h and she never typed one — the sizes were all the bot's.

The trigger now lives in the top-up block too, with the same shape as the
renewal one: the turn the customer agrees to a size is the turn that calls
`extract_order`, and closing a turn with "aku siapkan sekarang ya kak" or
"detail transfernya menyusul" without a tool call is named as forbidden. Neither
the alerting nor the extraction side was loosened: widening
`customerStatedSize()` adds an alert nobody watches, and building the order from
an inference is the thing that billed seven real customers twice (see "One order
per purchase" below).

## A restriction reaches the sheet only if the customer said it

**The summarizer prompt may not name a dietary restriction, and a customer who asked for nothing gets `Preferensi: tidak ada permintaan khusus.`** The prompt in `learn-context.ts` used to gloss the rule with an example — "dietary requests and restrictions (tanpa nasi, tidak pedas, tanpa seafood, alergi)" — and the model copied the parenthetical out as an observation. On 2026-08-30 five customers carried that exact list and only one had ever asked for any of it. Two had food on the calendar: Carolin (one delivery, 2026-09-01) and Kurniadi Tan, whose 16 rows started the next morning and whose 48 messages never mention food at all — his own bullet asserted three restrictions and then said they were *"tidak disebutkan eksplisit di transkrip"*. Julian S shows the second half of the damage: the invented list stood where his real request, *"Makanan tidak ada kacang dan Bawang goreng"*, should have been, so an invention did not merely add a wrong instruction, it displaced a right one.

This is not the protein bug wearing a different hat. That one copied a real sentence from the bot's own script into the wrong field; this one manufactures a fact about a customer from the instructions meant to define the field. No strip function can catch it, because the output is indistinguishable from a true bullet — `stripCompensation()` works only because "+25%" is a fixed token, and "tanpa nasi" is exactly what a genuine request looks like. The fix has to be that the instruction contains no restriction to copy, so `test/learned-preference-grounding.test.ts` asserts the prompt names none of the four terms and requires both the "stated it themselves … in this transcript" grounding and the exact empty-case wording. A customer who is *told* about a restriction, or asked whether they have one and says no, has not stated one.

Only the `Preferensi:` bullet is re-admitted to `/dapur/[id]` (`PREF_BULLET`), so this bullet is cooked from — an invented restriction is a wrong meal, not a cosmetic error. Note also the ordering trap when repairing the data: a regenerated summary overwrites the note on the customer's next message, which is how Carolin's corrected bullet came back an hour later. `scripts/fix-invented-preferences.ts` repaired the four false bullets, and it has to run **after** the prompt fix is deployed, never before.

## The name is asked before the bank details, and the tool enforces it

`customer_name` has always been in `extract_order`'s `required` list, and that was never worth anything: a placeholder satisfies the schema, and `isPlaceholderName()` then drops it on the way in — correctly, because a placeholder must not become someone's name. Nothing filled the hole it left. The order was created, the deliveries were generated, the record stayed `name: null`, and no flag and no follow-up ever pointed at it.

`+6287895957020` paid Rp 145.000 on 2026-08-26 for five September dinners after two days and sixty-odd messages in which nobody ever asked their name. It was not recoverable afterwards: not from the chat, and not from the transfer receipt, which shows only the recipient with the sender's account masked. Their five rows on the kitchen sheet print `—` where the name goes, because `/dapur/[id]` renders `{c?.name ?? "—"}` and **that dash stays a dash** — labelling the box with a phone fragment or a cluster name is a workaround for not having asked, and it would have hidden this for another six days.

The prompt already asked for the name and the model skipped it for two days straight, so the prompt alone does not hold. `createOrderFromExtraction` now refuses: when the customer's record has no name and the extraction supplies none either, it creates nothing, sends the customer the question itself, and returns. It refuses the **whole order**, not just the payment message — an order with no bank details behind it leaves the customer waiting on a transfer nobody asked them for.

The refusal is scoped to `sendPaymentInfo: true`. The payment-proof path (`sendPaymentInfo: false`) is a customer who has **already transferred**, and blocking there would throw away the order sitting behind real money — that is the one case where a nameless order is better than none. Audited 2026-08-26: of 375 customers, 167 have no usable name and only 2 of those ever reached an order.

## Nasi merah asked for after the order exists amends it too

`resizePendingOrderFromMessage` only ever read a size. Cindy Angelia's 5-porsi order was created at the moment she confirmed, *before* she sent the order form naming nasi merah, so it stayed at Rp 145.000 against a real Rp 170.000 and nothing anywhere reconciled it. The function now also matches `nasi\s*merah` on the inbound message and, on a `pending_payment` order whose `addon_cost_per_portion` is still 0, re-prices through `getExtractedOrderPricing(size, true)` and writes `NASI_MERAH_SURCHARGE`. Size and add-on are independent — either one alone is enough to amend, and neither touches an order once a proof is in, because by then the money has moved.

## Size M is offered per kitchen, and quoted before it is sold

The prompt used to say "Only size S is available. Never ask whether the customer wants S or M." Now S and M are both real: same nasi and lauk utama, M adds the fourth item on that week's menu, at `settings.size_m_surcharge` (Rp 4.000/porsi) on top of every tier — including a corporate contract rate, because it is a real extra dish the kitchen bills us for either way.

**Which kitchens cook M is read, never written down.** The prompt builds its size section from `dapurOptions[].offersM`, which comes from `subcontractors.offers_size_m`: it names the kitchens that have it, and falls back to the old S-only wording when none do. Only Dapur 1 has it today, and that is exactly why nothing may name Dapur 1 — a prompt, doc or `if` that does is wrong the day a second kitchen adds the dish, the same failure mode as writing the delivery areas into a string.

**The bot volunteers M; it does not wait to be asked.** The prompt originally said to default to S and never make the customer choose, which the model read as never mentioning M at all. Naya ordered on 2026-08-24, ate the S box for a week, and found out M existed on 2026-08-31 only when an admin took the thread over and told her — *"kyanya gada diinfo deh kak"*, *"gaada diinfo kak"*. She had no other way to know: the price list image is a photo of the S box. The rule now names both sizes **in the same message as the first price quote**, and again whenever the customer asks what is in a box or how big a porsi is — as an option beside the S total, never as a question they must answer before hearing a price. Pinned by "size M is volunteered, not waited for" in `test/api/system-prompt.test.ts`, which also checks the S-only wording still wins when no active kitchen cooks M.

**And the customers who bought before that rule existed are told too, one at a time.** Volunteering M on the first quote only reaches people who have not ordered yet. On 2026-08-31 there were **129 customers holding an active S package at a kitchen that cooks M**, Naya among them, and none of them will ever be quoted a price again — the bot had no reason to raise it. A broadcast cannot reach them either: 120 of the 129 have a closed 24h window, so a business-initiated send fails on `131042` (see `WHATSAPP.md`). So the prompt does it on their own next inbound. `activeOrder.onSizeSWithMAvailable` is computed in the webhook from the running order's `size` and *its own* `subcontractor_id` — a customer whose dapur is S only never hears the offer — and the rule says it once, at the end of whatever the customer actually asked about, then never again once it is anywhere in the thread history. Switching is an **escalation, not a tool call**: there is no code path that upgrades a running order (task `5510d897`), and `extract_order` would sell them a second package instead of changing the one they have.

Two rules the prompt carries: **S is the default**, so the model quotes S unless the customer asks about sizes, and it may only send `size: "m"` once the customer has picked M *and* heard the M price — the surcharge is not something to discover on the bank transfer. And it must never promise M for a kitchen that does not cook it. `createOrderFromExtraction` is the guard behind that promise: it re-reads `offers_size_m` after resolving the kitchen and writes S instead, rather than refusing, so the order still exists and the price matches the food. A kitchen sent an M row it cannot cook would print M on its sheet, cook S, and the customer would have paid the surcharge for a dish nobody made.

## A schedule that arrives after the order row is backfilled onto it

An order created the moment the customer confirms has no delivery rows if their days come in the *next* message, and nothing else ever writes them — nothing generates a schedule, and non-contiguous days could never have been derived from a range anyway. Cindy Angelia's 5-porsi order was created at turn 3; she named 11, 12, 13, 14 and 18 Agustus afterwards, and her order sat with an empty schedule.

`fillMissingSchedule()` (`src/lib/claude/extract-order.ts`) re-runs the forced-tool extraction and writes the `delivery_schedule` it returns, capped at the order's unbooked balance (`unbookedByOrder()`) so a package can never be over-booked, then sets `start_date`, `end_date` and the meal preference the days imply. It only ever touches an order with **zero** delivery rows, so it cannot duplicate a schedule already written.

It runs from `resizePendingOrderFromMessage`, on any amendment and on a message that merely lists dates — `DATE_LIST` is the cheap gate, since the extraction is a model call and must not fire on every inbound message. A dates-only message amends nothing about the money, so it never re-prices and never sends the customer a second nominal.

## A size the customer changes before paying amends the order

"Boleh 6 porsi dulu kak" after the transfer details have gone out is an amendment, not a second order and not a question — and nothing acted on it. Tiwi asked for "Total 8 porsi" on 2026-08-03, was quoted and billed for 8, then reduced to 6 in the next message; the order stayed at 8 and she was left holding a bill for a package she had just cut.

`resizePendingOrderFromMessage()` (`src/lib/claude/extract-order.ts`) runs on every inbound message before the model call, so the reply is generated against the amended order. It only touches an order in `pending_payment`: once a proof is in, the money has moved and a size change is an admin decision. It rewrites `package_size`, `price_per_portion` and `total_price` — nothing has been drawn against an unpaid order, so the balance moves with the size — re-prices through `getExtractedOrderPricing` (keeping the nasi merah surcharge when `addon_cost_per_portion > 0`), and sends the corrected nominal with the bank details.

The size is read by `statedBareTotal()`, the same parser `applyLatestCustomerSize` uses: exactly one bare total in the message, never a per-delivery figure ("1 porsi per pengiriman"), never a number carrying a thousands separator or preceded by a digit. That last guard exists because a replay pulled `15330` out of a message and would have priced a Rp 400 juta order; sizes past 500 are refused as a misread for the same reason. **The number and the word must also sit on the same line, and "Porsi:" as a form label never counts.** The gap used to be `\s*`, which crosses newlines: PT Bintang's filled order form ends one line in a maps link (`…WhZA3f6`) and starts the next with `Porsi: 22 box`, so the parser read the URL's trailing 6 and amended their correctly-created 110-porsi order down to 6. This was never corporate-specific — any customer whose maps link ends in a digit could shrink their own order the same way.

## An order the bot never booked is flagged to an admin, never built

"Saya catat pesanannya sekarang" with no `extract_order` in the same response is the most common way an order dies: the model treats creating it as an intention it can defer, and the next turn repeats the promise. Febby was quoted 30 porsi twice and no order ever existed; Tiwi's Rp 174.000 order died on "kurang nama lengkapnya aja kak". **Every reply that calls no tool runs `flagOrderAtRisk()`** — naming the shapes kept missing new ones, so the trigger is simply the absence of the tool call. `ORDER_PROMISE` and `consecutiveUnansweredQuestions()` survive only to label the reason handed to the admin.

**It flags. It does not create.** Until 2026-08-25 this path was `recoverOrderFromConversation()`, which built the order itself and let `createOrderFromExtraction` send the bank details. Seven customers were billed for packages they had not bought:

- Nicholas Satria wrote "halo kak menu minggu ini apa yaa" and got a Rp 280.000 transfer request twenty-seven seconds later, rebuilt out of his July renewal chat.
- Julian S asked to skip two deliveries and got Rp 145.000, plus two delivery rows on an order he never placed.
- galvent asked whether the portions came with fruit; Sherine Fayola asked whether she could swap days.
- Nadya asked to move one delivery to lunch, and her finished 8 Agustus package came back as a Rp 540.000 bill she had paid three weeks earlier.
- Fahmi asked where his dinner was and was billed Rp 448.000 for the sixteen portions he had already paid for. He replied "AI nya tolol". That order also carried a `start_date` in the past, so generation wrote a row for 24 Agustus and stamped it `delivered` — a meal nobody cooked, sitting in the ledger as served.

Eight guards were added across those incidents, in ten commits on 2026-08-19 alone, and the seventh phantom still got through. The thing being guarded is unguardable: "16 porsi" in a chat is genuinely ambiguous between buying sixteen and scheduling sixteen already owned, and no text rule separates them. Fahmi's own message — *"Okee 16 porsi ya, mulai besok"* — passed `customerStatedSize()` because he really did type it; he was scheduling what Annie had just apologised for missing.

What was fixable was the consequence. An inference no longer holds write authority, so a wrong one costs an admin a notification instead of costing a customer. `flagOrderAtRisk` sets `customer_flags.needs_human_review` and `escalation_reason`, pushes to all admins, and returns. No order row, no delivery rows, no payment message. Tiwi's order still does not die — it arrives in the inbox instead of billing her unattended.

**The order landing clears the flag** — `createOrderFromExtraction` sets `needs_human_review` back to false and nulls `escalation_reason` once the order row is written. Nothing used to: the trigger fires on any reply that called no tool, so a customer who simply took a few turns to answer stayed flagged for good after the order arrived. Carolin was flagged at 05:20 on 2026-08-29 with "Kemungkinan order belum tercatat: 5 porsi", ordered at 05:49, and was still flagged at 05:52; four of the nine standing flags were that shape (Gracia, Lidya, Keira, Julie) and were cleared by hand in the same change. A warning that has already come true is how the next real one gets ignored. `escalated_to_human` is untouched — that one is inbox takeover, and only an admin ends it.

Three filters remain, and only to keep the push rare:

- The extraction found an order at all, read through `extractOrderFromConversation(customerId, { since: newestOrder.created_at })`. The window starts after the newest order of **any** status, because for a returning customer the last 60 messages still contain the chat that produced the order they already have.
- `customerStatedSize()` — the extracted `package_size` must equal a number the customer typed themselves, newer than their newest order **and** inside the last 48 hours. A count of days is a portion count at one or two meals a day ("20 hari" → 20 or 40), a duration in weeks is five or six days each, and a bare number counts ("mau ambil yg 5 ka" is a renewal).
- Not an echo of an order on file: same `package_size` with the same `start_date`, or the same size on anything bought in the last 48 hours. Nicholas's phantom matched his active 10-porsi package on size and differed only on a start date the extraction had invented.

One push per unresolved flag — the trigger fires every turn, and an admin who has been told does not need telling again each time the customer writes.

The guards that went with the write: the min-package-size floor, the photo-address fallback (`hasInboundImage`, deleted), and the mid-flow gate with its Febby carve-out. All three existed to make an unattended write safe. A genuine top-up now reaches an admin like everything else, so the carve-out that let Fahmi through has nothing to carve.

`ORDER_PROMISE` stays broad on purpose. Narrowing it to exclude "sudah kami catat" would re-open the failure it exists for.

Phantoms already on file are cancelled by `scripts/cancel-phantom-orders.ts`, which also deletes their delivery rows. Note it decrements `customers.portions_remaining`, a dead column — do not follow that precedent. It no longer touches `orders.portions_remaining`, which migration 075 dropped.

## One order per purchase: `extract_order` amends the open one

The model re-calls `extract_order` every time it restates the summary, and each call inserted. Sherine Fayola was billed Rp 145.000, then Rp 540.000, then Rp 1.040.000 within thirteen minutes on 2026-08-19 — three orders and eighteen stray delivery rows for one purchase. `createOrderFromExtraction` now updates the customer's `pending_payment` order when one exists from the last 24 hours, deleting its deliveries first so the schedule is rebuilt from the amended size. Nothing has been drawn against an unpaid order, so size, price and balance all move with it; once a proof is in, the money has moved and a new order is a new order.

**The amend stops a second order; it does not stop a second bill.** The payment message was composed and sent on the amend path too, so a customer who confirms twice was asked to transfer twice. Rian's demo run on 2026-08-29 got the whole transfer block — bank number, nominal, 24h notice — after "Jadwalnya bebas aja kak" and again after "iya betul kak"; an unlabelled pair of identical bills is unreadable, and the second one re-sends the window notice as well. `createOrderFromExtraction` now skips the send on an amend when a message carrying that account number **and that nominal** is already on the thread since the open order was created. Keyed on what was actually sent, not on the order: an amend that changes the amount composes a different message and goes out, and an order whose payment message never reached the customer — the process died, or the order came from a payment proof — is asked normally, because nothing matching is on record. That second half matters more since the send moved after the reply (below): the window in which a death loses the message is wider now, and the next turn has to be able to recover it. `test/order-payment-once.test.ts` pins all three cases. **The check is asked twice, and the second time is immediately before the write.** Once was a read-then-write race: the first check runs while the tool is still executing, and under `deferPaymentMessage` the send then waits for the model's reply and its typing delay, so two turns from one burst both looked, both saw nothing, and both deferred the same message. Sharleen was asked to transfer Rp 1.690.000 twice on 2026-08-31, twenty-one seconds apart, by exactly that pair — and the burst supersede guard cannot help here, because a turn that called a tool is never dropped. `paymentAlreadyAsked()` is therefore called again at the top of `send()`.

**The bank details are the last thing the customer reads, not the first.** The model answers and calls `extract_order` in the same turn, and the tool used to send from inside `handleToolUse` while the reply waited behind the hallucination validator, the language guard and a typing delay — so "Silakan transfer ke…" arrived before "Saya lanjutkan pesanannya ya kak. Sebentar.", the sentence that introduces it. The webhook now passes `deferPaymentMessage: true` and `createOrderFromExtraction` returns the send instead of performing it; `processWebhookAsync` flushes it after its own reply has gone out, and on the echo path too, where the reply is dropped but the order behind it still has to be payable. Every exit from that function below the tool loop must flush, or the customer is told their order is being placed and never learns where to pay. `test/webhook.test.ts` T23 and T24 pin the ordering and the echo path.

**The amend is per customer, so one purchase for someone else still writes two orders.** On 2026-07-07 Maria Marcella asked to extend **Fiana**'s package to a month, was quoted 20 porsi Rp 540.000, said "langsung lanjut ya kak" and paid within three minutes. Two orders came out of that one conversation: `63383171` on Fiana — active, 19 delivery rows, the money and the food both on it — and `f9f95966` on Maria, same size, same price, same day, same `2026-07-08 → 2026-08-04` range, `pending_payment` with zero rows. The open-order lookup keys on `customer_id`, so a buyer ordering for a third party matches nothing and inserts. Maria's own package (`b29f2945`, paid 29 Juni) ran to 29 Juli and she declined an extension on the 30th — nobody was ever owed the second Rp 540.000. Two consequences: unpaid-exposure totals double-count a purchase like this, and the orphan copy reads as a real debt to every audit that looks at it. Before treating a `pending_payment` order as money owed, check whether the same package on the same day exists on another customer.

The same lookup fails the other way too, and more quietly. On 2026-08-24 Naya bought two packages in one conversation — 20 porsi for herself, 5 porsi for her friend Cila, both lunch, both starting 31 Agustus — and the bot quoted them separately, collected a form for each and sent two payment messages. Only Naya's order was ever written. `extract_order` amends or inserts against the `customer_id` whose chat it is, so the second package had nowhere to go: no customer row for Cila existed, and no order was created for her. Nothing failed loudly; the customer had been told her friend owed Rp 145.000 for food that was never on any calendar. **A package bought for someone else is now that person's order, and the bot builds it.** `extract_order` carries `beneficiary_name` and `beneficiary_phone`; `resolveBeneficiary()` (`src/lib/claude/extract-order.ts`) normalises the number, finds or creates that customer, and the order plus every delivery row lands on **them**, with `orders.paid_by_customer_id` naming the buyer. Cila's manual row (`IMPORT_cila` / `c18a4ec0`) is what that used to cost. Use `linked_order_id` only when the person draws from someone else's package, not when they bought their own.

Four things hold it together, and each is load-bearing:

- **The phone number is the identity, so it is required.** A beneficiary with no number can only ever be an `IMPORT_` placeholder that the next order for the same person will not match. If the model has a name and no number, or a number that will not normalise, `resolveBeneficiary` returns `ask`: the bot asks the buyer for it in Indonesian, pushes to admins, and **writes nothing**. Escalating is the answer to "nggak tahu nomornya" — never guessing, and never falling back to a placeholder.
- **An existing beneficiary's record is never rewritten.** The customers `.update()` runs only when the order is the buyer's own. The per-field guards in it only skip *blank* values; they have no way to notice that a non-blank value belongs to the wrong person, so Naya's address would have overwritten Cila's.
- **Chat-derived size overrides apply only to the buyer's own package.** `packageSizeMatchingPayment()` reads the buyer's transfer, and `statedTotal` / `weeksSize` / `rangeSize` read a conversation about two packages at once. Applied to the friend's order they turn 5 porsi into 20 — exactly the confusion that lost Cila's order in the first place.
- **The money is chased from the payer.** The quote goes to the buyer, labelled `📦 Ini untuk pesanan atas nama <name>`, and `cancel-unpaid` sends its notice to `paid_by_customer_id` when it is set. The beneficiary never receives a message: they never wrote to us, so there is no 24-hour window to send into, and they did not agree to anything.

`/payments` shows a **Dibayar oleh** line on any order with a payer, so a transfer arriving under a name that does not match the order is legible instead of alarming.

## A name already on the record is never overwritten

`createOrderFromExtraction` wrote `customer_name` from the extraction on every order, and the model returns whatever signature it reads off the chat: Julian S was renamed to "Julian" by a phantom order he never placed. The name is now only ever filled when the record has none.

That makes `rawNameForRecord` a **write-flag, not a display name** — it is deliberately null for exactly the customers whose name we already know. The payment message read it as a name anyway (`rawNameForRecord?.split(" ")[0] ?? "kak"`), so a returning customer with a name on file got the fallback and the greeting came out **"Terima kasih kak kak!"** — 6 messages across 4 customers between 19 and 25 Agustus, and only ever the customers we know best. The greeting now reads `existingName` first and falls back to the bare `"kak"` with no doubling. Never read `rawNameForRecord` for display: it is null precisely when there is something to display.

## The bot must not claim it sent the menu without sending it

The model writes "menu minggu ini sudah saya kirim gambarnya ya" and calls no tool. Nicholas Satria was told to check an image that was never sent and answered "blmm ada kak"; Sherine Fayola was told the same thing an hour later. The webhook matches `claimsMenuSent()` on any toolless reply and, when we have sent this customer no image since they last spoke, runs `send_menu_image` itself. Sending the menu twice costs nothing; telling someone to look at an image that does not exist costs a customer.

**The guard failed on 2026-08-26 and every part of it was wrong at once.** ****7277 asked to see the menu before committing, was told *"Berikut menu gambar untuk minggu ini … saya kirimkan ya"* followed by a literal **`[gambar menu terkirim]`**, replied "belum ada fotonya kak maaf", and was answered *"Oh iya kak, maaf. Saya kirimkan lagi menu minggu ini … sekarang ya"* — and the same brackets again. Two claims, four minutes apart, no `send_menu_image` behind either. Four separate defects, each of which alone would have been enough:

- **The pattern only matched the past tense.** It required `sudah|udah|telah` between the noun and the verb. Both replies were present tense, and a promise to send *in this message* sends the customer looking for an image just as surely. `MENU_SENT_CLAIM` now also covers "saya kirimkan menunya", "menu … saya kirimkan" with the week wedged between, "berikut/ini dia menunya", and the bracketed placeholder itself. A genuinely future "nanti saya kirim" is cut from the text before matching, not used to veto the reply — one message can defer next week's menu and claim this week's, and that one must still fire.
- **The 15-minute window suppressed the recovery.** The welcome sequence sends a price list and a menu on first contact, so for the next quarter hour every menu claim read as already true. Both of ****7277's claims fell inside it. The window is gone: `sentImageSinceLastInbound()` asks whether an image went out **since the customer last spoke**. An image older than their question is a different question, already answered, and asking again earns a resend — while the welcome images, which land after that first inbound, still correctly suppress a claim in the same turn.
- **We taught the model the placeholder.** `historyContent()` rewrites a sent image to a bracketed phrase so the model never sees a bare storage URL to copy (see "The model must never see a media URL as message text"). Untagged, that phrase read as ordinary assistant prose and the model copied *it* instead — the fix for the URL leak became the cause of the fake send. The marker is now `[sistem: gambar sudah terkirim ke customer]`, and the prompt says outright that such lines are the system's record of images that really went out, never something to write.
- **The prompt authorised it.** Two lines told the model to *say* the menu had been sent: "Tell customers the menu image has been sent (or will be sent)" and "If you cannot call the tool, say the image will be sent". Both are gone. Calling the tool is the only thing that sends an image, and saying so is not.

`sanitizeReply()` strips `[gambar menu terkirim]` and its variants as a last pass, so even when the resend fires the customer never reads our stage directions. That strip is not the fix — it is the half that keeps the failure invisible to the customer while the resend makes it untrue.

## A tool result says what the tool actually did

DeepSeek spends a turn on `thinking` + `tool_use` and emits no text, so the webhook runs the tool and then calls the model again to get the sentence that should have come with it. That second call fed it the literal string `"done"` as the tool result — for every tool, whatever happened. `record_daily_order` alone has eight ways to write nothing (no valid date, no active order, no draw order, no unbooked quota, every date a libur nasional, every date already on the sheet, quota short of one day, an insert error), and each of them arrived at the model as success. It could answer *"sudah tercatat kak"* over an empty calendar and be doing exactly what it was told.

`handleToolUse()` now returns `{ ok: true, message } | { ok: false, error }` and the result is JSON-encoded into the `tool_result` block, with `is_error` set on a failure. The messages are written in Indonesian because the model paraphrases them straight into its reply, and the failing ones say what not to claim — *"Tidak ada yang tercatat — jangan bilang jadwalnya sudah masuk"*. Partial success is a success that names the dropped dates, since booking four of six days and confirming all six is the same lie in a smaller form. `extract_order` is still the one branch that cannot report truthfully. `createOrderFromExtraction()` returns a `CreateOrderResult` as of 2026-08-29, but that only carries the deferred payment send — it says nothing about whether an order was written, and the function withholds one when the days or a beneficiary's number are missing. So its tool result says only that the tool ran, and tells the model not to restate the amount or the bank details, which the system composes itself and the model never sees. A return value that reports what happened is still the next step; the type now exists to hang it on.

The recovery guards call `handleToolUse()` too, and a failed recovery is worse than a failed tool call — the reply claiming the menu was sent or the dates were booked has already gone out. Both now push an admin with the `error` string when the recovery does not land.

Those eight guards now live in `src/lib/orders/record-daily-order.ts` (2026-08-29), not in `handleToolUse`, where they were 200 of that function's 354 lines and could only be exercised by driving a whole webhook payload through the route. `test/record-daily-order.test.ts` pins each of them plus the three that matter most in the happy path: a libur nasional inside a run is dropped and named while the rest books, a run longer than the quota books what it can afford and reports the days it dropped, and the rows are charged to the order `pickDrawOrder()` picks rather than the newest one. The route now passes `tool.input` through and returns what the function says.

## The model is told the state this turn produced, not the state it started with

`stateRow` is read once near the top of `processWebhookAsync` and carried all the way to `buildSystemPrompt()`. Two writes in between changed the database and left the snapshot alone: `state -> "ordering"` when the classifier calls the message an order, and `menu_shown -> true` when the welcome sequence claims its slot. So the model was told `customerState: "new"` on the exact turn the customer started ordering, and `menuShown: false` immediately after the welcome message, price list, menu images and T&C had gone out — which is an invitation to send them again. Both writes now update the in-memory row as well. Covered by T20/T21 in `test/webhook.test.ts`.

## The turn after the welcome sequence is given a job

`processWebhookAsync` sends the welcome blast on first contact — greeting, price list, menu images, T&C, window notice — and then calls `processSavedCustomerMessage()` **unconditionally**. So the model gets a turn immediately after, with one inbound message it has already been answered by the system. 153 of the first 223 welcomed customers got that turn.

Everything the model could usefully say has just been sent, and the prompt's own rules forbid the two obvious replies: no greeting ("the customer has already been welcomed"), no mentioning the menu (`menuShown: true` says "do not mention or re-send"). That leaves nothing it is permitted to say, and what it emits instead depends on the casual coin flip — polished mode pads out a paragraph, casual mode is told to text "like a friend texting quickly" and returns the shortest friendly noise available. On 2026-08-27 a click-to-WhatsApp ad lead got twelve tokens: *"Aku cek dulu bentar ya kak"* — a promise to check something nobody had asked about. Nothing schedules a second turn, so nothing followed; two days later the 24-hour window closed and `131042` blocked any reach. Of 54 ad leads, 17 are one-and-done and 5 ordered.

The fix is a job, not a skipped call — a first contact deserves a reply, and the same hole reopens for anyone who greets us with "halo". `justWelcomed` is set on the request that wins the `menu_shown` claim (`claimed.length > 0`), threaded through `processSavedCustomerMessage()` into `buildSystemPrompt()`, and adds one block: the turn's whole job is **one question that moves the order forward** — how many porsi, or which area — asked in at most two sentences. It names the stalls it is replacing (*"aku cek dulu"*, *"sebentar ya"*, *"silakan liat-liat dulu"*) and says why they are wrong: nothing is being checked and no second turn is coming. It applies in casual mode too — casual changes the wording, never the job. Draft mode and the replay-latest path leave the flag false. Pinned by "the turn right after the welcome sequence" in `test/api/system-prompt.test.ts`.

Which mode produced any given reply cannot be recovered: `casual` is computed per turn at `route.ts:1620` and never written down. The attribution above rests on register (*aku*, *bentar*, no punctuation) and a 12-token output, not on a stored flag.

## A delivery date the bot promised is booked even when it never called the tool

The `extract_order` recovery has a twin for the customers who already bought. The model confirms dates to someone with quota left and calls no `record_daily_order`, so nothing reaches the sheet, no kitchen is told, and the customer waits for food nobody cooked. Fahmi paused on 11 Agustus, asked on 22 Agustus to resume, and was answered *"saya jadwalkan pengiriman mulai Senin 24 Agustus ya"* — no tool call, no row. Nothing downstream would have caught it either: there is no nightly generator. Rows are written upfront at order creation, so an order that is already inserted has nothing watching it — the `/api/cron/generate-deliveries` route that read like a backstop had never once run and was deleted on 2026-08-25. On 24 Agustus at 18:22 WIB he wrote "Dah nyampe blom kak".

The webhook now matches `SCHEDULE_PROMISE` on any reply that called no `record_daily_order`, for a customer with an active order and `schedule.unbooked > 0`, and hands the reply to `extractPromisedSchedule()` — a small model call that resolves "mulai Senin 24 Agustus", "besok dan lusa" or "Senin sampai Jumat" into ISO dates against the WIB clock. As with order recovery, the sentence shape is only the trigger; the extraction is the guard. It returns null for an offer, a question, or anything it cannot date, drops dates before today, and refuses to invent an end date for a bare "mulai". What it returns goes through `handleToolUse("record_daily_order")`, the same path the tool call would have taken, so the active-order check, `pickDrawOrder()`, the customer-wide quota gate, the libur nasional drop and the double-booking skip all still apply — a wrong guess is dropped there, never written. If no dates can be recovered, admins get a high-priority push instead, because by then the customer has already been told the dates are set.

`SCHEDULE_PROMISE` alone was the trigger until 2026-08-30, and it needs a delivery verb (`jadwalkan`, `kirim`, `antar`, `mulai`) within 60 characters of a date — the shape of Fahmi's reply, and only that shape. Vania sent *"selasa 1 sep / rabu 2 sep / jumat 4 sep"* and was answered with the three dates as a bulleted confirmation followed, two sentences later, by *"Saya catat pesanannya sekarang ya kak ✅ Sebentar ya, saya proses dulu"*. No delivery verb sits near any date there: the promise and the dates are in different sentences, nothing matched, no recovery ran, and three dinners she had been told were booked reached no kitchen sheet. Her next message asked how much quota was left and got arithmetic that assumed the rows existed.

The trigger is now `promisesSchedule()`, which is that pattern **or** an `ORDER_PROMISE` anywhere in the reply plus a date anywhere in it. Widening the pre-filter is cheap because it is only a pre-filter: `extractPromisedSchedule()` still returns nothing for a reply that merely offers or asks, and the caller has already established that the customer holds unbooked quota and that no `record_daily_order` ran this turn. Do not tighten it back into a proximity rule — the model writes the promise and the dates in whatever order it likes.

## Neither a block of days nor a renewal produces a schedule any more

Two rules used to live here: a duration with no meal named was filled with `lunch_only`, and a renewal inherited the days of the customer's most recent standing order. Both were deleted on 2026-08-28 along with the rest of the inference ladder — see "The days are required, and nothing infers them". A renewal that restates no days is now an order with no days, which is a normal order: the customer books each date through `record_daily_order`. The size half of the duration rule is kept (`statedWeeks()`); only the invented week is gone.

The corpus is filtered to match: a case whose customer messages never state a size in words — a package agreed from an order form sent as a photo — is dropped rather than scored, because the model never sees images and cannot reproduce it.

## Three questions in a row is a loop, and the webhook breaks it

A promise the bot never keeps is one way an order dies; the opposite is the other. The bot claims nothing, it just asks one more question every turn. Lina Marlianty gave "2 minggu, 1 porsi" and her address on 2026-08-18 and was asked "siang, malam, atau keduanya?" three times running — the prompt has forbidden exactly that since the meal default was written, and the model does it anyway.

`consecutiveUnansweredQuestions()` counts the assistant replies ending in a question with no `extract_order` between them. It no longer gates anything — recovery runs on every toolless reply (see the section above) — and is kept because "a clarification loop" is the most useful reason to read in the log when an order had to be recovered.

## `package_size` is floored, never trusted blindly

`orders.package_size` is NOT NULL and is the field DeepSeek drops most: two replays on 2026-08-19 (Kurniadi Tan, Fidela) threw `null value in column "package_size"` on the insert, so the customer got nothing. A third (Dewi) returned `3` for a customer who had agreed to 5, and 3 matched no `pricing_tiers` row — `.lte("portions", 3)` returned nothing and `?? 0` made it a **Rp 0 order**. Both are now floored: the size is `max(model value, smallest tier)` and the price falls back to the cheapest tier when no row is at or below the size. An approximate price an admin adjusts beats an order that does not exist or one the kitchen cooks for free.

The floor guards the write, not the sentence. A lead (`+6281213330779`) hesitated over one day's sayur inside a 6-porsi (Rp 174.000) proposal on 2026-08-22 and was told that skipping that day "otomatis jadi paket 4 porsi = Rp 116.000" — under the 5-porsi floor, a multiple of neither 5 nor 6, and a direct contradiction of the reply one message earlier that said skipped quota is kept. `createOrderFromExtraction` would have refused to write it, so the damage was the quote itself: a price the customer had been promised and we do not sell. The prompt now states that dropping a delivery day never shrinks the package — quota is bought, not rented per day, so a skip leaves the portions in the balance and the total and price stay put.

## A parked or taken-over thread still banks a payment proof

Both early-return branches in the webhook — `escalated_to_human` and `pending_bot_response` — used to save an inbound image as a bare `[Image]` and return, so `handlePaymentProofImage` never ran: the bytes were never copied into `payment-proofs`, the order stayed `pending_payment`, and it never appeared in the Payments page's Pending verification tab. Tiwi (`+6287808781094`) paid Rp 174.000 on 2026-08-18 into a thread parked by the validator bug, and her proof sat in the inbox as an unlabelled photo with nothing anywhere saying money had arrived.

Capturing the proof is bookkeeping, not the bot talking, so both branches now call `handlePaymentProofImage(..., { sendConfirmation: false })` when the latest order is `pending_payment`. That advances the order and stores the image but sends the customer nothing — a thread a human is holding must not get an automated reply — and pushes to admins at **high** priority instead of medium, because on those threads no one else is watching. `scripts/rescue-payment-proof.ts` repairs a proof that was already swallowed.

## Replaying real conversations against the bot

`scripts/replay-orders.ts` plays the customer turns of the last N real ordering conversations back through the **live** pipeline — same prompt, same tools, same validator, same handlers — and checks whether the bot still produces the order and the deliveries the real conversation produced. The real `orders` / `daily_deliveries` rows are the ground truth, so the corpus needs no hand-written expectations. Built after 2026-08-18, when three separate defects (last-tool-only parsing, a validator blind to the conversation, a payment proof dropped on a parked thread) each reached a customer before anyone noticed.

Three things make it safe to run against production data:

- **A demo recipient can never reach Meta.** Demo customers' `phone_number` starts `DEMO_` — deliberately not a number, so no real customer's phone can ever match however it is formatted — and every send function in `src/lib/whatsapp/client.ts` returns a fake wamid for them. The guard is on the recipient's identity, never an env var: a flag that silences sends would silence real ones the day it is set wrong, and the check has to hold for the crons and the assistant too, not just the harness.
- **A demo row never carries the real customer's name.** The conversation being replayed is a real one, so extraction returns the real name and it used to be written straight to the demo customer — putting a second "Nadya" in the inbox thread list beside the actual customer, one tap away from an admin answering a replay instead of a person. `demoDisplayName()` (`src/lib/whatsapp/demo.ts`) names them `[DEMO] <phone suffix>`, applied both where the harness creates the row and where `createOrderFromExtraction` would otherwise overwrite it.
- **Demo rows never outlive the run.** Each case deletes its customer and everything it created, before and after, and the run ends with a sweep. `--keep` retains them for inspection.
- **`Date` is pinned per turn** to the original message's timestamp, so "besok" and "senin depan" resolve to what they meant at the time and the expected delivery dates stay comparable. The pin is a script-local override of the global `Date`, not a parameter threaded through production code.

Bursts are pre-merged into one turn by the corpus builder (messages under 90s apart), and `processWebhookAsync` skips its 15s burst wait for demo phones — otherwise a 20-conversation run would spend an extra hour sleeping without changing what the model sees.

**A returning customer replays with the record they actually had.** The demo row was created blank, and a returning customer never retypes their address — the prompt forbids asking — so extraction's fallback to `customers.address` found nothing and both recovery gates blocked on it. Febby was quoted 30 porsi at Rp 810.000 and the bot then waited for a form she had no reason to fill in: "NO ORDER CREATED" for exactly the customers we know best. The harness now copies `address` / `area` / `sub_area` / `subcontractor_id` onto the demo row, but **only when the customer already had an order before the replayed window** — a first-time customer states their address in the very turns being scored, so seeding it would hand the bot the answer. The name is never copied; `demoDisplayName()` still owns it.

**Ground truth is real orders, so it has to be kept real.** Three ways it stopped being: a corpus rebuilt mid-round picked up the harness's own demo orders (an order the bot just wrote can never be evidence of what the bot should write — demo customers are now skipped); a **cancelled** order counted as something to reproduce, which put the phantom Nadya order of 2026-08-19 in the corpus and asked the bot to rebuild a bug (cancelled and refunded statuses are excluded); and a conversation that produced **two** orders entered twice with different expectations, while one replay run creates one order — Tiwi's 2026-08-03 thread bought 5 porsi and then 6, so at most one of the two could ever pass. Sibling orders from the same window now fold into `alternatives` on a single case, and reproducing any of them passes.

**A wedged turn is retried once.** DeepSeek drops connections and hangs often enough that infrastructure, not the bot, decided a case in each of rounds 12–14 — Vania, Fidela, Henny and Nadya all lost turns to `ECONNRESET` or the 300s deadline. A turn is a customer message, so losing one loses the order. The harness now replays the same payload once before recording the turn as failed; `message_id` is unchanged, so `processed_messages` skips a turn that actually landed before wedging rather than processing it twice.

**A replay run must never outlive the session that launched it.** The shards are child processes and nothing supervises them, so if Claude Code hits its usage limit mid-round the run keeps calling DeepSeek — spending real balance — until the limit resets, with no one able to stop it. `scripts/replay-guard.sh <minutes> [args...]` launches the replay in its own process group and kills the whole group on either of two stops: a hard wall-clock deadline, or the session's five-hour rate limit reaching `REPLAY_KILL_AT_PCT` (default 90). The rate limit is the one that matters, and the figure exists only on the status line — Claude Code pushes it to the status-line command on stdin and stores it nowhere — so `~/.claude/statusline-command.sh` writes `rate_limits.five_hour.used_percentage` to `/tmp/claude-rate-limit-pct` on every render and the guard polls that file. **That hook lives outside the repo; a machine without it loses the rate-limit stop and keeps only the wall clock.** Use the guard for every round; `pnpm tsx scripts/replay-orders.ts` directly has no stop at all.

**A green scorecard from prompt-patching is worth nothing.** The failure mode of this harness is tuning `system.ts` until 20 specific transcripts pass, which teaches the bot those conversations rather than ordering. Fix code freely; treat a prompt change as a business-rule decision that needs a reason beyond "the replay went green".

**A corporate customer replays with their contract rate.** `contract_price_per_portion` is copied onto the demo row regardless of whether the customer had ordered before — unlike the address, which is only seeded for a returning customer, because a rate is a property of who they are and never something stated in the turns being scored. `currentRulePrice()` reads it too: without that, PT Bintang's correct Rp 35.000 scored against the tier-below rule's Rp 26.000 and the bot was marked wrong for pricing them exactly right.

**Historical orders can disagree with current rules, and those cases are unscoreable, not red.** Fidela's 8-porsi order from 27 Juli is not a sellable total under the current ladder, and PT Bintang's Rp 35.000/porsi is corporate pricing no tier produces. No price the bot can write is right for those, so the harness reports them as **DRIFT** with both numbers and keeps them out of the pass/fail tally — counting them as failures marks the bot down for obeying a current rule, and "fixing" them would mean breaking one. Everything else about a drifted case (package size, deliveries) is still printed; it is simply not scored.
