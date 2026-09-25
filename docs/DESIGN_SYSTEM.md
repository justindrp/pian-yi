# Design system

Brand rules for everything a customer sees that we draw: Instagram/Meta Ads creative, the weekly menu card, the price list, the invoice and quotation PDF, and katerloka.com. Lives here rather than in a Downloads folder so it can be corrected in the same commit as the code that renders it — the version that sat outside the repo described a lunch box the business stopped selling and nobody noticed for months.

**The brand is Katerloka** (chosen 2026-09-23). It replaces Pian Yi Catering, whose red-and-gold look — flat `#C0181C`, `#F7C948`, Poppins over Nunito and a white PNG logo — was retired with the name on 2026-09-26. Nothing below should drift back to it. The visual brand book (logo masters, tokens, surface mock-ups) is the Katerloka Design System artifact, https://claude.ai/artifact/8gtMzna8v5NS4jRCuhVLai; this file is the part the code must obey.

The personality is **warm and dependable**: *makan beres tiap hari*. Sell reliability, never cheapness — no *murah*, *termurah* or *hemat banget* anywhere.

| Artifact | Size | How it is made |
| --- | --- | --- |
| Instagram / Meta Ads post | 4:5 vertical | real photos laid out by hand, or prompted out of an image model |
| **Weekly menu card** | 1080×1350 (4:5) | `scripts/menu-card.ts` — real HTML/CSS through headless chromium, only the food photos are generated |
| **Price list** | 1080×1350 (4:5) | `scripts/price-list.ts` — same pipeline, no photos at all; every figure comes out of the database |
| **Invoice / quotation** | A4 PDF | `src/lib/invoices/render.ts` — pdfkit on Railway, no browser |
| **katerloka.com** | phone column | `src/app/(catalog)/`, styled by `catalog.css` |

Anything about layout precision applies to the rendered surfaces automatically and to a generated post only as a request the model may ignore.

---

## Palette

The colours are named after the kitchen: **cabai** (chili), **daun** (banana leaf), **kunyit** (turmeric), **nasi** (rice), **kecap** (sweet soy). They live in exactly two places that carry the same values — `BRAND` in `src/lib/brand/logo.ts` (menu card, price list, invoice) and the `--kl-*` tokens at the top of `src/app/(catalog)/catalog.css` (katerloka.com). **Change both in the same commit**, or the site and the sheets it links to stop matching.

| Name | Hex | Use |
| --- | --- | --- |
| cabai | `#BF3419` | the logo, the primary button, day names, kickers, one headline accent |
| cabai-deep | `#9A2A14` | text on cabai-soft |
| cabai-soft | `#FBE9E4` | request chips, selected states |
| daun | `#1F4D3A` | sheet footers, the invoice total band |
| daun-soft | `#E4EFE8` | SIANG / MALAM pills |
| kunyit | `#F2B33D` | the size M pill, the WhatsApp number on daun — one highlight per surface |
| nasi | `#F7F5F1` | the ground of every sheet and page |
| surface | `#FFFFFF` | cards on nasi, the invoice page |
| kecap | `#1C1917` | text |
| ink-2 | `#46403B` | secondary text, dish lists |
| muted | `#6E6760` | captions, dates, rates |
| line | `#E8E3DC` | hairlines |
| ok | `#1E7A46` | "LUNAS", always with its word |

- **Text on kunyit is kecap, never white** — white on kunyit fails contrast. Text on cabai and daun is white.
- There was once a print red (`#C0181C`) and a web red (`#bf3419`). There is one red now, cabai.
- There is one theme. Every surface is a light, printed-feeling object; katerloka.com does not follow the phone's dark mode.

**The sheet ground is one flat colour**, nasi, with no gradient. On the rendered sheets that is checkable:

```
magick .menu-photos/card-dapur-suplir.png -format "%[pixel:p{4,4}]" info:   # → srgb(247,245,241)
```

Check the PNG, never the uploaded JPEG — JPEG rounds the value, which is compression, not a wrong colour.

---

## Typography

One family: **Plus Jakarta Sans** — 800 for headlines and prices, 700 for card titles, 600 for emphasis and captions, 400 for body. Nothing lighter.

- The menu card and price list fetch it from Google Fonts at render time; katerloka.com loads it with `next/font`.
- **The invoice embeds it from `src/lib/brand/fonts/`**, and that folder is listed in `outputFileTracingIncludes` in `next.config.ts`. Railway runs the standalone build, which copies only what it traced; without that line the font files are missing in production and every invoice send throws.
- Uppercase is for kickers and pills, plus the kitchen name on the menu card. Headlines otherwise are sentence case.
- Prices are `Rp 26.000` — a space after `Rp`, dots for thousands, weight 800, tabular figures. `Rp 26rb` is allowed only in a tight row on katerloka.com.

---

## The logo

The **tray lockup**: the real four-compartment lunch tray seen from above, with a scoop of rice, beside the lowercase wordmark `katerloka`. The masters (lockup, avatar, white versions) are SVGs in the artifact's Logos group.

- **The wordmark is outlined, never retyped.** The paths are `LOCKUP` in `src/lib/brand/logo.ts`. The HTML sheets inline `lockupSvg(ground, height)`, the invoice draws the paths with pdfkit, and katerloka.com draws them as JSX (`BrandLockup` in `src/app/(catalog)/ui.tsx`). None of them sets "katerloka" in a font.
- Colour version (cabai tray, kecap word) on nasi or white; all-white on cabai or daun. No other recolouring, outlines, shadows or stretching.
- Clear space around it equals the height of the `k`.
- The avatar (Instagram, WhatsApp, app icon) is the tray alone on a cabai disc — the wordmark is unreadable at 110px. `public/icon-512.png` is still a green "PY" placeholder and has not been replaced.

### The name bridge

The WhatsApp display name still reads Pian Yi Catering until Meta approves the rename, so a customer receiving a Katerloka invoice from a "Pian Yi" chat would reasonably wonder who sent it. Every rendered surface therefore carries **`FORMER_NAME`** ("dulu Pian Yi Catering", `src/lib/brand/logo.ts`): under the invoice's brand lines and in the sheet footers. When the display name changes, empty that one constant's uses and re-render — it is a bridge, not part of the brand.

---

## The lunch box

**Rewritten 2026-08-31 against a real delivery photo.** Every earlier version of this section described a white five-compartment paper box with a propped-open lid, honeydew melon cubes and a piece of tahu bacem beside the rice. That is not what a customer receives, and the AI plate photos on the Batch 51 card were generated from that description — white paper, five compartments, heaped edge to edge. The real box is smaller, darker and plainer than the spec had been claiming for as long as the spec existed.

### What actually ships

`scripts/assets/reference-box-2026-08-18.jpg` is the photograph this section is written from — a real delivery, 18 Agustus 2026, **deskewed** (the handheld original leans 21°), cropped to the whole tray with a small margin, and stripped of its EXIF (the original carried GPS to the metre). It is checked in so the claims below can be checked against something rather than trusted. **When the packaging changes, replace it and rewrite this section in the same commit**, and date the new filename the same way; a reference photo whose date nobody can see is a reference photo nobody knows to distrust.


- **Black glossy plastic tray**, moulded compartments. Not paper, no lid in frame, no inner liner.
- **Four compartments:** one large along the bottom for rice, a small well for sambal, two more for the lauk and the sayur.
- **Modest portions.** Bare black tray stays visible around every item. The rice is one scoop filling about half its compartment — not a dome rising above the walls.
- Shot from directly above at 90°, zero tilt.

### Contents follow `subcontractors.menu_text`, never this document

Size S is **nasi + lauk utama + sayur + sambal** — four things, which is why the tray has four compartments. Size M is size S **plus one extra lauk** for that kitchen's `subcontractors.size_m_surcharge` (the house fallback is `settings.size_m_surcharge`, Rp 4.000/porsi; Molls charge 6.500), in the same four-compartment tray.

Two errors this replaces, both of which reached customers:

- The old badge text — *"Nasi + Lauk + 2 Sayur + Side Dish + Buah"* — sells five or six items. Do not use it. There is no fruit and no second sayur.
- The old size spec made S and M a **portion** difference (*"S = 2–3 very small chicken pieces, M = 4–5"*). They are an **item count** difference. A card or an ad that shows M as a fuller tray of the same food is describing a product that does not exist, and the surcharge looks like paying more for the same thing.

**Never write this week's dishes into a prompt by hand.** `scripts/menu-photos.ts` builds every photo prompt out of the same `menu_text` string the card prints, which is the only reason the two cannot drift. Batch 51's hand-prompted card plated Chicken Katsu as tempeh sticks.

That column holds one week. A kitchen that publishes a month at a time — Homey send one poster for all of September — has the rest of its weeks in `subcontractor_menu_weeks`, and `scripts/menu-week.ts` promotes one into `menu_text` before the card is drawn. Transcribing the poster is still a human reading a picture; doing it once a month beats doing it weekly from an image nobody kept. See "Weeks we hold but have not published" in `docs/DEV_REFERENCE.md`.

### Portion honesty

A generated plate that holds more food than the tray does is the Batch 51 complaint in a worse form. Naya compared five printed bullets against four items in her box; she could be answered in words. A customer comparing a heaped photo against a half-full tray cannot be — there is no wording that walks a photo back, and the card footer says *"Foto menampilkan porsi size M"*, so the photo is a claim we are making.

Image models cannot count. Asking for four compartments reliably yields four to six. Compartment count is worth stating and not worth re-rolling for.

**Fullness is not controllable in prose at all, so stop trying.** Two rounds of wording — "modest everyday catering portions", "bare tray stays visible", "never fill edge to edge" — both came back as heaped restaurant plates. What works is passing the reference photograph itself: `scripts/menu-photos.ts` calls `/v1/images/edits` with `scripts/assets/reference-box-2026-08-18.jpg` attached and asks the model to keep the tray, the angle and *how little food is in it*, replacing only the dishes. The portion then tracks the real box, because it is being copied rather than described. Note `input_fidelity` is rejected by `gpt-image-2`; the reference conditions the output without it.

**The model copies the reference's geometry too, so the reference has to be straight — and the output is straightened anyway.** The first reference was the handheld original, tilted 21° and cropped so the tray ran off the top and bottom of the frame; every generated tray came back at its own angle and the card read as five snapshots rather than one set. Prompt wording ("zero tilt", "edges parallel to the frame") does not fix it. Two changes did: the reference is deskewed and shows the whole tray, and `deskew()` in `scripts/menu-photos.ts` rotates each generated PNG upright before it is written. That last step does not ask the model anything — with a transparent background the alpha channel *is* the tray silhouette, so the angle whose bounding box is smallest is the angle the tray stands upright at (searched over ±25°, then trimmed). Keep "the whole tray is inside the frame" in the prompt: a tray clipped by the frame deskews into a diagonal cut edge. `deskew()` also turns the tray on its side at the end, because the card's photo slot is wider than it is tall; the generation stays portrait, which is the tray's own aspect and so spends the most pixels on it.

---

## Delivery areas — read them, never type them

The areas are the union of the `delivery_areas` of whichever subcontractors are active right now. They are per kitchen, they change when a kitchen is activated or deactivated, and an area can rest on a single kitchen.

Read them with `activeDeliveryAreas(db)` (`src/lib/subcontractors/areas.ts`), or `useDeliveryAreas()` in the dashboard. `scripts/menu-card.ts` already does. Any list of areas written into a design document, a prompt or a caption is a snapshot that starts going stale the day it is written — the previous version of this file carried one in two places.

---

## Confidentiality in creative

Never name a subcontractor, in an image, a caption or a prompt. Customers see the `customer_nickname` only ("Dapur Suplir"), or "dapur partner kami". The rule covers every kitchen, present and future.

That partner kitchens *exist* is not secret — a customer who names a supplier gets neither denial nor confirmation, because "kami masak sendiri" is a lie they can check. Never show COGS, margins or internal operations.

---

## The weekly menu card

Rendered by `scripts/menu-card.ts`, so this is a specification the output actually obeys. Full pipeline and commands: "The weekly menu card" in `docs/DEV_REFERENCE.md`.

- 1080×1350 at 2× device scale → 2160×2700 PNG.
- Header, left-aligned on nasi: the tray lockup (`lockupSvg("light", 52)`, the outlined paths — the card carries the name through the logo and prints no brand name of its own), then the "MENU MINGGUAN" kicker in cabai, **the kitchen's `customer_nickname` in Plus Jakarta Sans 800**, and the date range in muted. The size legend sits top-right: an outlined `S` pill and a kunyit `M` pill.
- **The headline is the kitchen's nickname, and the kitchen's own title sits above it in the kicker.** With one kitchen the headline was its batch number; with three, two cards whose headline is a generic title differ only in their dish lists and their area footer, and a customer offered all three cannot ask for one by name. So "MENU MINGGUAN · Batch 53" is the kicker and **DAPUR SUPLIR** is the headline. A kitchen with no nickname keeps the old layout rather than falling back to `subcontractors.name`, which is the supplier's real name and never reaches a customer. A nickname over 12 characters drops a size — "DAPUR MONSTERA" at full size left no gap before the size legend.
- **`menu_text` is a format, not free text, and a kitchen's own message is not in it.** `parseMenu()` wants line 1 to be a title-and-range ending in a full stop, line 2 a note it does not print, and then one line per day shaped `Senin 28 September: …` with dishes separated by **commas**. Molls' column held Ika's WhatsApp message as sent — bare weekday headings, `Siang:`/`Malam:` on their own lines, dishes separated by hyphens — and the card rendered with an empty header and no days at all. Transcribe an intake message into this shape before the card is drawn; nothing validates it, and the only symptom is an empty card.
- **Do not pad the day lists to say what the legend already says.** The size legend prints the box contents ("nasi + lauk + sayur + sambal"), so naming rice again in each day cost twelve extra lines and overflowed every MALAM panel past what the render's font-fitter can recover at its 13px floor, clipping the last dish off all six of Molls' days. The fitter shrinks type; it cannot add height.
- **The title on line 1 of `menu_text` is optional.** `Batch 53 — 7 s/d 12 September.` is Thenie's own numbering; a kitchen that numbers nothing writes `7 s/d 13 September 2026.` and the kicker prints "MENU MINGGUAN" alone. Do not invent a title to fill the slot — the placeholder "Menu Reguler" printed "MENU MINGGUAN · MENU REGULER" across the top of two cards.
- One white day card per delivery day. Photo, then the day name in cabai (sentence case), then the date, then the size S items — **four lines, which must count correctly on their own** — then a kunyit `+ SIZE M` pill and the tambahan item below it.
- The S list and the M block are drawn apart. This is the whole reason the card was rebuilt: a suffix or a footnote leaves an S customer counting five bullets and hunting for a legend a thousand pixels away.
- Chef-recommendation days print "CHEF'S CHOICE / Menu spesial pilihan chef, diumumkan H-1" and get no photo.
- Footer: a full-width daun band with the delivery areas (read, not typed) and the day-range-and-cutoff line in white, the WhatsApp number in kunyit, and the name bridge ("Katerloka · dulu Pian Yi Catering") under it.
- Photos are cutouts standing in the day card with a drop shadow — no frame around the photo itself.
- **The photo slot is 196px tall, and that number is what keeps the footer on the page.** At 240px the six-day Suplir card pushed the daun footer off the bottom of the 1350px canvas; the tray is wider than it is tall, so the extra height was only empty card above each tray.

**The card is per kitchen, and so is everything on it.** `scripts/menu-card.ts --kitchen X` renders one kitchen; the size legend prints "SATU UKURAN" rather than the S/M pair when that kitchen's `offers_size_m` is false, the footer's day range comes from its `delivery_days`, and the areas from its own `delivery_areas`. A kitchen that cooks Senin–Jumat must not be handed a card whose footer says Senin–Sabtu, and a kitchen with no size M must not show an M price for a box it does not pack.

**A kitchen with no generated photos gets a written card** — two columns of white panels instead of three columns of cutouts, because with the photo slot empty the dishes are the whole cell and need a panel of their own. A kitchen whose lunch and dinner differ prints both under daun-soft SIANG and MALAM pills in the same cell. The type on a written card is fitted after layout, not chosen in advance: six days of separate lunch and dinner is twice the text of five single line-ups, so the render shrinks the list font until the densest panel stops overflowing. Without that, Dapur Palem's Jumat and Sabtu ran off the bottom of the card and took the footer with them.

**The grid is counted from the days, and a seventh day buys a column rather than a row.** Two columns up to six days, three from seven — Santapin cook Minggu, so their week has seven panels. Cell *height* is what a split-meal card runs out of, so splitting the same page into four rows made every panel shorter and clipped all seven; three columns keeps the panel height of a six-day card. A chef's-choice panel on a written card carries no invisible photo spacer either: the spacer exists to line a text panel up with its photographed neighbours, and on a card with no photos it pushed the panel's own words out of the clip, so Santapin's Minggu rendered as an empty box.

**Ask the image model for transparency; never knock it out afterwards.** `background: "transparent"` gives an alpha edge with no colour of its own. Cutting a photo off a coloured background leaves anti-aliased edge pixels holding *that* colour at partial alpha, which reads as a dark halo on any other ground.

---

## The price list

Rendered by `scripts/price-list.ts` onto the same 1080×1350 nasi sheet as the menu card — lockup, kicker, legend, daun footer — so the two read as one set. It is what `send_price_list` hands a customer who asks for prices. Commands: "The price list" in `docs/DEV_REFERENCE.md`.

- Header mirrors the card: the lockup, the "DAFTAR HARGA · <nickname>" kicker, "PAKET PERSONAL", and the same top-right size legend.
- One table, three columns — the package in *hari*, then Lunch **atau** Dinner, then Lunch **&** Dinner — grouped Mingguan / Bulanan / 3 Bulan.
- **Every figure is computed from `pricing_tiers` at render time**, never typed. The row is a day count; the portions are that count, doubled for the lunch-&-dinner column; the rate is the largest listed tier at or below the portions, the same rule `createOrderFromExtraction` prices by. Change a tier and re-run — there is no second place holding these numbers.
- Each cell is a white card. Figures print as `Rp 540.000` with a small muted `Rp` in front and the per-porsi rate beside them (`Rp 27.000/porsi`) — the old `540k` shorthand is gone with the old look.
- Below each S price sits the M price, smaller, behind a kunyit `M` chip so it reads as an option rather than a competing number.

**The M price is printed, not left as a sum for the customer.** The surcharge is per *porsi* while the rows are labelled in *hari*, and in the lunch-&-dinner column those differ by 2×: "20 hari" there is 40 porsi, so M is +Rp 160.000, not +80.000. A band stating the rule once would be a cleaner sheet that starts arguments — the customer halves it, quotes themselves a price, and the bot has to correct them.

**M disappears entirely when no active kitchen has `offers_size_m`** — rows, legend and all. Coverage is per kitchen the same way delivery areas are, and printing a price for a dish nobody cooks is worse than printing no price.

**The ongkir line is read, not asserted.** The sheet said "Gratis ongkir" and "Harga sudah termasuk ongkir" in fixed text, which was true while every kitchen was in Tangsel and delivered for nothing. Molls charge Rp 10.000–15.000 on *every* kecamatan they serve, so that line would have promised free delivery across the whole of their coverage on the one artefact `send_price_list` hands a customer who asked what things cost. A kitchen now states the range when its `subcontractor_neighborhoods` fees cover **every** `area_neighborhoods` row of its `delivery_areas`, and keeps the old line otherwise. The count is what matters, not the presence of fees: `subcontractor_neighborhoods` is an exclusion list, so Thenie's only two rows are the Apartemen Akasa surcharges of migration 086 and reading those as a standing ongkir would have announced one on a kitchen that drives Tangsel free.

**The nasi merah surcharge is the one number on the sheet that is not in the database.** It lives in the system prompt (`src/lib/claude/prompts/system.ts`) and in `extract_order`; `NASI_MERAH` in the script has to be changed with them, or the sheet quotes one figure while the bot charges another.

**The sheet it replaced pictured the S box only.** A customer who asked for prices had no way to learn size M existed — half of Naya's dispute on 2026-08-31, and unanswerable in words once she had the picture. Any future size, add-on or tier has to reach this sheet in the same commit it reaches the ladder.

---

## Instagram / Meta Ads posts

Real photos on Instagram; generated tray cutouts belong to the menu card only. **Never post a generated photo as if it were a real delivery.**

### Real photos

Taken at the kitchen or on delivery, in daylight, from above or at 45°, cropped into a rounded frame. The food is the subject: no props, no hands holding phones, no kitchen staff's faces without their consent. Portions are what the box holds.

### Layout, top to bottom

1. **Top** — the lockup, top-left, about 56px tall on a 1080px canvas.
2. **Headline** — one Plus Jakarta Sans 800 line in kecap on nasi, at most one word in cabai. Nothing on a post is smaller than 24px.
3. **Photo** — in a rounded frame.
4. **Bottom 25%** — empty nasi when the post runs as an ad, reserved for Meta's call-to-action overlay. All content fits in the top 75%.

A **story** (1080×1920) keeps text and logo out of the top 250px and bottom 340px, where Instagram draws its own controls.

An **announcement post** (a new kitchen, a new area, a libur) may invert: cabai ground, white type, at most one kunyit word at 24px or larger. Never for the menu.

### Comparison posts

Left half is the competitor ("Catering Lain"), full grayscale, grey label and ✗. Right half is Katerloka in full colour with a ✓. A 2px line divides them, the full height of the comparison zone.

### Checklist and badge

Ticks are plain `✓` marks — not emoji, not coloured boxes — in one left-aligned column. **A badge's text must describe the box that ships**; see "The lunch box" above before writing one.

---

## Absolute constraints

1. No decoration — no stars, sparkles, glows, swooshes, stickers or gradients. Flat colour and real food.
2. No cream-and-serif "artisan" look, and no red-and-gold (that was Pian Yi).
3. No phone number and no QR code inside a *generated* image. The sheets typeset both as real text, which is different.
4. No logo inside a generated image. Composite the real lockup instead.
5. One flat ground colour per surface. No panels behind text on a post.
6. Generated food photography: no plates, no surfaces, no backdrops.
7. Portions are modest and the tray shows through. Never "filled edge to edge", and never size M as a fuller tray of the same food.
8. No subcontractor name, ever.
9. No delivery-area list or price written by hand — link to katerloka.com instead.
10. At most one emoji per caption, and none on a rendered sheet.

---

## Generator notes

Current image model is **OpenAI `gpt-image-2`**, called directly over `fetch` from `scripts/menu-photos.ts` with `background: "transparent"`, `output_format: "png"`, `size: "1024x1536"` (portrait, the tray's own aspect — `deskew()` turns the result landscape for the card). About $0.041 per image at medium quality, ~$0.21 for a week.

Two rules inherited from the previous Gemini/Nano Banana workflow no longer apply and should not be carried into new prompts: there is **no unavoidable watermark** to work around, and transparency is a parameter rather than something to ask for in prose and then repair.

When writing a prompt for a post: state the format first, state the flat nasi `#F7F5F1` ground early, describe the real tray from "The lunch box" above, and end with the constraints list.

---

## Reference

- **Brand:** Katerloka (dulu Pian Yi Catering) — daily lunch and dinner subscription delivery
- **Site:** katerloka.com · **Email:** halo@katerloka.com
- **Instagram:** @pianyicatering is the handle on record; change this line when the account is renamed
- **WhatsApp:** 0851-1121-4390 (0878-3298-7510 is retired — never use it)
- **Design System artifact:** https://claude.ai/artifact/8gtMzna8v5NS4jRCuhVLai
