# Import & Reconcile Task — Handoff for Codex

Goal: stop Annie's manual DB work. Make `scripts/import-customers-orders.ts` the single
re-runnable reconcile tool that pulls Annie's Google Sheets into Supabase and **computes
every customer's remaining quota correctly** (today it's hand-typed in the sheet and wrong
for everyone).

Read this whole file before writing code. Follow the repo conventions in `CLAUDE.md`
(pnpm only, Biome only, `rtk` prefix on shell cmds, typecheck before push, commit+push
after every change, double-push because the pre-push hook bumps the version).

---

## Decisions already made by the owner (do not re-litigate)

1. **ORDER_HARIAN sheet = source of truth for deliveries.** It holds the customer's FULL
   delivery history since **2025-12-29** plus upcoming (future-dated) deliveries.
2. **CUSTOMERS sheet "Sisa Kuota" (remaining) is UNRELIABLE** — hand-updated daily, error
   prone. **Do NOT use it for `portions_remaining`.** Ignore that column entirely.
3. **Original purchased package size comes from a NEW sheet: `package_orders`** (not from
   CUSTOMERS). This is the quota the customer paid for.
4. **Remaining is COMPUTED, never typed:**
   `portions_remaining = package_size − (sum of ORDER_HARIAN portions delivered up to AND
   including today)`. Future-dated ORDER_HARIAN rows do NOT deduct yet.
5. Customers themselves should NOT be re-imported blindly — see "the earlier mishap" below.

---

## Google Sheets (one spreadsheet, three tabs)

Spreadsheet ID: `13cKpPcqdqXTpqWrWL5sDiZVNrYClzSBcrypO_CPZTgI`

| Tab | gid | Role |
|-----|-----|------|
| CUSTOMERS | `1454452383` | customer master (name/phone/area/address). Remaining column = garbage, ignore. |
| ORDER_HARIAN | `1975392427` | per-day delivery rows = source of truth for deliveries |
| package_orders | `341974326` | **NEW** — original purchased package per customer/order. Columns UNKNOWN — inspect first. |

CSV export URL pattern (the script already has `toSheetsCsvUrl`):
`https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<gid>`

The script already defaults to the CUSTOMERS + ORDER_HARIAN URLs. Add a default for
package_orders too.

---

## STEP 0 (do this first): inspect `package_orders`

Its columns are unknown. Before coding, fetch it and print headers + a few rows:

```bash
set -a && . ./.env.local && set +a
# quick inspect — write a tiny scripts/_inspect.ts that fetches the CSV and console.logs
# header row + first 5 rows, then `rtk pnpm tsx scripts/_inspect.ts`, then delete it.
```

Determine:
- Which column = customer identity (name? phone? customer_number?) to join to CUSTOMERS/ORDER_HARIAN.
- Which column = purchased package size (porsi).
- Which = price per portion and/or total paid, order/purchase date.
- Whether a customer can have MULTIPLE package_orders rows over time (re-purchases).

Report findings, then implement the mapping below accordingly.

---

## Reconcile algorithm to implement

Run mode: `--reconcile` (new flag) using `package_orders` + `ORDER_HARIAN`, matching
customers that already exist in the DB by phone/name (same matching the script already does
in `--skip-customers` mode via `customerIdByName`).

Per customer:
1. **package_size** = from `package_orders`. If a customer has multiple purchase rows and the
   model is one-order-per-package, create/match one order per purchase row. If the simpler
   "one active order per customer" model is acceptable, `package_size = Σ package_orders rows`
   for that customer. **Decide after STEP 0 and state which you chose.**
2. **delivered_to_date** = Σ ORDER_HARIAN `portions` for that customer where
   `delivery_date <= today`.
3. **portions_remaining = package_size − delivered_to_date** (clamp at 0; if negative, log a
   warning — means sheet inconsistency).
4. Update the order row(s): `package_size`, `portions_remaining`, `price_per_portion`,
   `total_price = package_size × price_per_portion`, `start_date`. Use the existing
   allowlisted update path; do NOT touch `status` or accounting journals.
5. Upsert ORDER_HARIAN delivery rows into `daily_deliveries` (the script already does this;
   keep `onConflict: "delivery_date,customer_id,meal_type"`).

Add `--dry-run`: print a table of `customer | package | delivered | computed_remaining |
old_remaining` and write NOTHING. Owner wants to eyeball before committing.

Keep `--after=YYYY-MM-DD` (already added) for delivery date filtering when needed.

---

## Current state of the script (already done this session)

`scripts/import-customers-orders.ts` already has:
- `--skip-customers` (build name→id + order maps from DB instead of importing customers)
- `--after=YYYY-MM-DD` (import only ORDER_HARIAN rows with `date > after`)
- valueless-flag parsing fix (`else args[cleaned] = ""`)
- default CUSTOMERS + ORDER_HARIAN sheet URLs

What's MISSING (your job): the `package_orders` source, the `--reconcile` mode, the
computed-remaining logic, and `--dry-run`.

Note the existing customer-import path sets `portions_remaining = totalPortions` (full
package) and never subtracts deliveries — that is the root bug. Your reconcile mode replaces
that with computed remaining.

---

## The earlier mishap (context, not a task)

A buggy run (the valueless-flag bug, now fixed) executed a FULL import instead of
skip-customers. It:
- inserted 2 customers: **Monica**, **Taro**
- inserted 3 orders (Monica 8p/224k, Taro 4p/116k, + a junk 0p/0 order on an existing cust)
- upserted ~148 existing customers, overwriting these fields from the sheet:
  `name, address, area, sub_area, google_maps_link, notes, subcontractor_id,
  portions_remaining, avg_price_per_portion, customer_number, delivery_route`
- inserted 76 wanted deliveries (29 Jun–28 Jul)

Owner chose NOT to do a full DB restore (would lose the 76 deliveries + other live activity).
The reconcile run will fix `portions_remaining` anyway. The junk 0-portion order and
Monica/Taro may still want manual cleanup — confirm with owner.

---

## Environment / commands

- Linked Supabase project: **pian-yi** (`mtepdwekiifqdtzhqoys`), Singapore.
- Load env before running tsx (tsx does NOT auto-load .env):
  ```bash
  set -a && . ./.env.local && set +a && rtk pnpm tsx scripts/import-customers-orders.ts <flags>
  ```
- Required env: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (in `.env.local`).
- Temp inspect scripts must live UNDER the repo (e.g. `scripts/_inspect.ts`) so
  `@supabase/supabase-js` resolves; delete them after. tsx eval (`-e`) fails on top-level
  await — use a file with an async `main()`.

## Quality gates (must pass before commit)

```bash
rtk pnpm typecheck      # must be clean
rtk pnpm lint           # Biome, must be clean
rtk pnpm test           # add a test if you add/extend a route or import branch
```

Commit + push (push twice — the `.githooks/pre-push` hook bumps package.json version and
amends the commit, so the first push is rejected and the second succeeds):

```bash
rtk git add <files> && rtk git commit -m "<conventional msg>" && rtk git push; rtk git push
```

Commit message footer:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

Update `CLAUDE.md` (scripts section) + `DATABASE.md` in the same commit if behavior changes.

---

## Open questions to resolve by INSPECTING data (don't ask the owner unless truly stuck)

1. package_orders join key + package/price/date columns (STEP 0).
2. One-order-per-purchase vs one-order-per-customer (Σ packages). Pick based on whether
   customers have multiple purchase rows; state your choice in the commit body.
3. Whether ORDER_HARIAN meal rows already carry an `order_id` link or must be matched by
   customer+address (the script currently matches by `customerId:alamatSlug`, falling back to
   any order for the customer).

## Definition of done

- `rtk pnpm tsx scripts/import-customers-orders.ts --reconcile --dry-run` prints the
  per-customer remaining diff and writes nothing.
- Without `--dry-run`, it updates package_size/remaining/price/total + upserts deliveries.
- Spot-check 3 customers: computed remaining = package − deliveries-to-date. Matches reality.
- Gates green, committed, pushed.
