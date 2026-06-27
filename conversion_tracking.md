# Conversion Tracking — Feature Implementation

## Context

This is the Pian Yi Catering web app (`pian-yi.up.railway.app`). The app manages customers, orders, deliveries, and payments for a daily catering business in BSD City, Indonesia.

We run Meta Ads campaigns. Each ad creative has a unique tag embedded in the WhatsApp pre-fill message that customers send when they click the ad. For example:

- C4 ad → pre-fill contains `[C4]`
- C5 ad → pre-fill contains `[C5]`
- C6 ad → pre-fill contains `[C6]`

When a new customer messages us via WhatsApp, Agnes (admin) records them in the app. The first message they send contains the creative tag. We need to track which ad creative drove each conversion, and display this data in the Reports section.

---

## Definition of Conversion

A conversion is recorded when a customer makes their **first payment**. Not when they place their first order — when the first payment is confirmed received.

---

## What Needs to Be Built

### 1. Data Model

Add the following fields to the Customer record (or a linked Conversion record — use whichever fits the existing schema better):

| Field | Type | Description |
|---|---|---|
| `ad_creative` | string | The creative tag parsed from the first WhatsApp message (e.g. "C4", "C5", "C6"). Null if organic/no tag detected. |
| `first_message` | text | The raw first WhatsApp message from the customer. Used as source for tag parsing. |
| `converted_at` | datetime | Timestamp of the customer's first payment confirmation. |
| `package` | string | The package they bought (e.g. "10 porsi", "20 porsi", "40 porsi"). |
| `total_portions` | integer | Total number of portions in the first order. |
| `total_payment` | integer | Total payment amount in Rupiah for the first order. |
| `promo_used` | string | Name/code of promo used, if any (e.g. "Rp17k porsi pertama"). Null if none. |
| `converted_to_subscription` | boolean | Whether the customer subsequently renewed/subscribed after the first order. Default false. |
| `area` | string | Delivery area (Alsut, BSD Lama, BSD Baru, GS, Karawaci). Already exists — link to it. |
| `notes` | text | Free text notes about this conversion. |

---

### 2. Creative Tag Detection Logic

When a new customer is created and their first message is saved:

1. Scan the `first_message` field for a pattern matching `[C\d+]` (e.g. `[C4]`, `[C5]`, `[C6]`, `[C7]`, etc.)
2. If a match is found, extract the tag (e.g. "C4") and save it to `ad_creative`
3. If no match is found, set `ad_creative` to null (organic)
4. This detection should run automatically on save — Agnes should not have to manually enter the creative tag

---

### 3. Manual Override

On the Customer detail page, add an editable field for `ad_creative` so Agnes can manually correct or set the creative tag if the auto-detection missed it or the customer didn't use the pre-fill message.

---

### 4. Conversion Recording

When a payment is confirmed for a customer who has no `converted_at` timestamp yet:

1. Automatically set `converted_at` to the current datetime
2. Populate `total_portions` and `total_payment` from the payment record
3. Populate `package` based on the order
4. Do NOT overwrite `converted_at` on subsequent payments — only the first payment triggers this

---

### 5. Reports Section — Conversion Tracking Page

Add a new page or tab inside the existing Reports section called **"Conversion Tracking"**.

#### Summary Cards (top of page)

Display the following metrics as cards:

| Metric | Description |
|---|---|
| Total Conversions | Count of all customers with a `converted_at` timestamp |
| Conversions This Month | Count filtered to current calendar month |
| Total Revenue from Conversions | Sum of `total_payment` for all conversions |
| Revenue This Month | Sum filtered to current calendar month |
| Top Creative | The `ad_creative` value with the most conversions |
| Organic Conversions | Count where `ad_creative` is null |

#### Breakdown Table by Creative

A table showing per-creative performance:

| Column | Description |
|---|---|
| Creative | C4, C5, C6, Organic, etc. |
| Conversions | Count of customers with this creative tag |
| Total Revenue (Rp) | Sum of `total_payment` |
| Avg Order Value (Rp) | Average `total_payment` |
| Subscribed | Count where `converted_to_subscription` = true |
| Subscription Rate | Subscribed ÷ Conversions (%) |

#### Full Conversion Log (bottom of page)

A paginated table of all individual conversions, sortable by date, with the following columns:

| Column |
|---|
| Date |
| Customer Name |
| Area |
| Creative |
| Package |
| Total Portions |
| Total Payment (Rp) |
| Promo Used |
| Converted to Subscription |
| Notes |

Add a **date range filter** at the top so Justin can filter by custom date ranges.

Add an **export to CSV** button.

---

### 6. Subscription Conversion Toggle

On the Customer detail page, add a simple toggle or checkbox:
**"Converted to subscription"** — when Agnes marks this, it sets `converted_to_subscription` to true and updates the Reports accordingly.

---

## Notes for Implementation

- The app is hosted on Railway. Check the existing stack before choosing how to implement the data model changes (migration vs schema update).
- All currency values are in Indonesian Rupiah (Rp), stored as integers (no decimals).
- Area values match the existing area enum in the app: Alsut, BSD Lama, BSD Baru, GS, Karawaci.
- The creative tag format is always `[CX]` where X is a number. Future creatives will follow the same pattern (C7, C8, etc.) — the regex must be generic, not hardcoded to C4/C5/C6.
- Do not break any existing functionality in the Reports section. Add the Conversion Tracking as a new tab or sub-page.
