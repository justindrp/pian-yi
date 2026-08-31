# Design system

Brand rules for anything customers see as an image: Instagram/Meta Ads creative, the weekly menu card, the price list. Lives here rather than in a Downloads folder so it can be corrected in the same commit as the code that renders it — the version that sat outside the repo described a lunch box the business stopped selling and nobody noticed for months.

Two artifacts use these rules and they are built in opposite ways:

| Artifact | Size | How it is made |
| --- | --- | --- |
| Instagram / Meta Ads post | 4:5 vertical | prompted out of an image model, laid out by the model |
| **Weekly menu card** | 1080×1350 (4:5) | `scripts/menu-card.ts` — real HTML/CSS through headless chromium, only the food photos are generated |

Anything about layout precision applies to the card automatically and to the post only as a request the model may ignore.

---

## Palette

| Role | Colour | Hex |
| --- | --- | --- |
| Primary background | Deep red | `#C0181C` |
| Accent / price / day names | Bright yellow | `#F7C948` |
| Primary text | White | `#FFFFFF` |
| Badge & pill text | Dark charcoal | `#2B2B2B` |
| Badge background | White | `#FFFFFF` |
| WhatsApp indicator | WhatsApp green | `#25D366` |

**The background is one flat colour.** No gradient, no panels, no zones, no shading. Every background pixel is exactly `#C0181C`. On the card this is verifiable and worth verifying:

```
magick .menu-photos/card.png -format "%[pixel:p{4,4}]" info:   # → srgb(192,24,28)
```

Check it against the PNG, never the uploaded JPEG — JPEG rounds it to `srgb(193,24,29)`, which is compression, not a wrong colour.

---

## Typography

| Type | Font | Weight | Colour |
| --- | --- | --- | --- |
| H1 — headline / batch number | Poppins | ExtraBold | White |
| H2 — subheading, price, day name | Poppins | Bold | Yellow `#F7C948`, or white |
| Body | Nunito | Regular | White |
| Photo-overlay label | Poppins | Bold | White (Pian Yi) / grey (competitor) |
| Badge / pill | Poppins | Medium | Charcoal `#2B2B2B` on white or gold |
| Footer | Nunito | Regular | White |

Prices are always Poppins Bold in `#F7C948`, Indonesian separators: `Rp500.000`.

The card fetches both families from Google Fonts at render time, so nothing depends on what is installed locally.

---

## The lunch box

**Rewritten 2026-08-31 against a real delivery photo.** Every earlier version of this section described a white five-compartment paper box with a propped-open lid, honeydew melon cubes and a piece of tahu bacem beside the rice. That is not what a customer receives, and the AI plate photos on the Batch 51 card were generated from that description — white paper, five compartments, heaped edge to edge. The real box is smaller, darker and plainer than the spec had been claiming for as long as the spec existed.

### What actually ships

`scripts/assets/reference-box-2026-08-18.jpg` is the photograph this section is written from — a real delivery, 18 Agustus 2026, cropped to the tray and stripped of its EXIF (the original carried GPS to the metre). It is checked in so the claims below can be checked against something rather than trusted. **When the packaging changes, replace it and rewrite this section in the same commit**, and date the new filename the same way; a reference photo whose date nobody can see is a reference photo nobody knows to distrust.


- **Black glossy plastic tray**, moulded compartments. Not paper, no lid in frame, no inner liner.
- **Four compartments:** one large along the bottom for rice, a small well for sambal, two more for the lauk and the sayur.
- **Modest portions.** Bare black tray stays visible around every item. The rice is one scoop filling about half its compartment — not a dome rising above the walls.
- Shot from directly above at 90°, zero tilt.

### Contents follow `subcontractors.menu_text`, never this document

Size S is **nasi + lauk utama + sayur + sambal** — four things, which is why the tray has four compartments. Size M is size S **plus one extra lauk** for `settings.size_m_surcharge` (Rp 4.000/porsi today), in the same four-compartment tray.

Two errors this replaces, both of which reached customers:

- The old badge text — *"Nasi + Lauk + 2 Sayur + Side Dish + Buah"* — sells five or six items. Do not use it. There is no fruit and no second sayur.
- The old size spec made S and M a **portion** difference (*"S = 2–3 very small chicken pieces, M = 4–5"*). They are an **item count** difference. A card or an ad that shows M as a fuller tray of the same food is describing a product that does not exist, and the surcharge looks like paying more for the same thing.

**Never write this week's dishes into a prompt by hand.** `scripts/menu-photos.ts` builds every photo prompt out of the same `menu_text` string the card prints, which is the only reason the two cannot drift. Batch 51's hand-prompted card plated Chicken Katsu as tempeh sticks.

### Portion honesty

A generated plate that holds more food than the tray does is the Batch 51 complaint in a worse form. Naya compared five printed bullets against four items in her box; she could be answered in words. A customer comparing a heaped photo against a half-full tray cannot be — there is no wording that walks a photo back, and the card footer says *"Foto menampilkan porsi size M"*, so the photo is a claim we are making.

Image models cannot count. Asking for four compartments reliably yields four to six. Compartment count is worth stating and not worth re-rolling for; **fullness is worth re-rolling for**, because that is the part a customer measures against their own lunch.

---

## Delivery areas — read them, never type them

The areas are the union of the `delivery_areas` of whichever subcontractors are active right now. They are per kitchen, they change when a kitchen is activated or deactivated, and an area can rest on a single kitchen.

Read them with `activeDeliveryAreas(db)` (`src/lib/subcontractors/areas.ts`), or `useDeliveryAreas()` in the dashboard. `scripts/menu-card.ts` already does. Any list of areas written into a design document, a prompt or a caption is a snapshot that starts going stale the day it is written — the previous version of this file carried one in two places.

---

## Confidentiality in creative

Never name a subcontractor, in an image, a caption or a prompt. Customers see the `customer_nickname` only ("Dapur 1"), or "dapur partner kami". The rule covers every kitchen, present and future.

That partner kitchens *exist* is not secret — a customer who names a supplier gets neither denial nor confirmation, because "kami masak sendiri" is a lie they can check. Never show COGS, margins or internal operations.

---

## The weekly menu card

Rendered by `scripts/menu-card.ts`, so this is a specification the output actually obeys. Full pipeline and commands: "The weekly menu card" in `docs/DEV_REFERENCE.md`.

- 1080×1350 at 2× device scale → 2160×2700 PNG.
- Header, left-aligned: the real logo (`scripts/assets/menu-card-logo.png`, white-on-transparent, carries the wordmark so the card prints no brand name of its own), then "MENU MINGGUAN", the batch number in Poppins ExtraBold, and the date range. Size legend sits top-right.
- One cell per delivery day. Photo, then day name in `#F7C948`, then the date, then the size S items — **four bullets, which must count correctly on their own** — then a gold `+ SIZE M` pill and the tambahan item below it.
- The S list and the M block are drawn apart. This is the whole reason the card was rebuilt: a suffix or a footnote leaves an S customer counting five bullets and hunting for a legend a thousand pixels away.
- Chef-recommendation days print "CHEF'S CHOICE / Menu spesial pilihan chef, diumumkan H-1" and get no photo.
- Footer: delivery areas (read, not typed), the WhatsApp number, and the cutoff line.
- Photos are cutouts floating on the flat red with a drop shadow — no cell boxes, no frames.

**Ask the image model for transparency; never knock it out afterwards.** `background: "transparent"` gives an alpha edge with no colour of its own. Cutting a photo off a coloured background leaves anti-aliased edge pixels holding *that* colour at partial alpha, which reads as a dark halo on any other ground.

---

## Instagram / Meta Ads posts

Still generated by prompting an image model. These rules are requests, not guarantees — check the output against them.

### Zones, top to bottom

1. **Top 10–12%** — empty red, reserved for a logo added in post-production. (The menu card does not use this zone; it draws the real logo.)
2. **Visual zone** — 48–55% for comparison posts, 40–45% for food-only. Photos bleed to both edges: no rounded corners, no border, no frame, no inset, no padding. No plate, no table, no surface behind the food.
3. **Text zone** — all text sits directly on flat red. No panel or shape behind any text. Order: H1 → H2 → body → checklist → badge → area footer.
4. **Bottom 25%** — empty red, reserved for the Meta Ads CTA overlay. All content must fit in the top 75%.

### Comparison posts

Left half is the competitor ("Catering Lain"), full grayscale with a 10–15% red tint over it, grey label and ✗. Right half is Pian Yi in full colour, white label and ✓. A 2px white vertical line divides them, full height of the comparison zone.

### Checklist and badge

Ticks are plain `✓` marks — not emoji, not coloured boxes — in a single left-aligned column. The badge is a white rounded pill, charcoal Poppins Medium. **Its text must describe the box that ships**; see "The lunch box" above before writing one.

---

## Absolute constraints

1. No decorative elements anywhere — no stars, sparkles, diamonds, swooshes. Corners stay empty.
2. No phone number and no QR code inside a *generated* image. (The card draws both as real text, which is different — it is typeset, not hallucinated.)
3. No logo inside a generated image. The card composites the real file instead.
4. Background is one flat colour. No panels, no zones, no variation.
5. Food photography: no plates, no surfaces, no backdrops.
6. Portions are modest and the tray shows through. Never "filled edge to edge".
7. No subcontractor name, ever.
8. No delivery-area list written by hand.

---

## Generator notes

Current image model is **OpenAI `gpt-image-2`**, called directly over `fetch` from `scripts/menu-photos.ts` with `background: "transparent"`, `output_format: "png"`, `size: "1536x1024"`. About $0.041 per image at medium quality, ~$0.21 for a week.

Two rules inherited from the previous Gemini/Nano Banana workflow no longer apply and should not be carried into new prompts: there is **no unavoidable watermark** to work around, and transparency is a parameter rather than something to ask for in prose and then repair.

When writing any new prompt: state the format first, state the flat `#C0181C` background rule early, describe the real tray from "The lunch box" above, and end with the constraints list.

---

## Reference

- **Brand:** Pian Yi Catering — daily lunch and dinner subscription delivery
- **Instagram:** @pianyicatering
- **WhatsApp:** 0851-1121-4390 (0878-3298-7510 is retired — never use it)
