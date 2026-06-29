# Data Audit — Google Sheets vs Supabase

_Generated 2026-06-29. Re-run: `set -a && . ./.env.local && set +a && pnpm tsx scripts/audit-sheet-data.ts`_

DB customers: **161** · package_orders rows: **1000** · ORDER_HARIAN rows: **3364**

## A. package_orders — names with NO matching DB customer

These purchases are not counted toward any customer's quota. Either the customer is missing from the DB, or the name is spelled differently.

| Sheet name | Rows | Σ Porsi | Likely DB match? |
|---|---|---|---|
| panti | 1 | 35 | — (not in DB?) |
| Melvin | 1 | 20 | Melvina |
| bila | 1 | 20 | Nabila |
| joce | 2 | 12 | — (not in DB?) |
| grace | 1 | 10 | Grace K |
| Vini | 1 | 8 | Vidi |
| kezia | 1 | 8 | — (not in DB?) |
| Onny | 1 | 6 | Fenny |
| vivi | 1 | 5 | Vidi |
| sensen | 1 | 5 | — (not in DB?) |
| tambahan acara | 1 | 3 | — (not in DB?) |
| Syifa | 1 | 2 | — (not in DB?) |
| kevin aurelio | 1 | 2 | — (not in DB?) |
| reyhan | 1 | 0 | — (not in DB?) |

## A2. package_orders — purchases with NO customer name (orphan purchases)

Rows that record a date / portions / amount but have a blank Nama. Real money/quota that belongs to nobody — cannot be credited to any customer.

**24 orphan purchases:**

| Date | Detail |
|---|---|
| 05/25/2026 | 2 porsi · Rp58.000 |
| 05/18/2026 | 52 porsi · Rp1.560.000 |
| 05/07/2026 | 0 porsi · Rp0 |
| 04/19/2026 | 4 porsi · Rp112.000 |
| 04/15/2026 | 4 porsi · Rp140.000 |
| 04/15/2026 | 10 porsi · Rp270.000 |
| 04/10/2026 | 20 porsi · Rp520.000 |
| 04/09/2026 | 2 porsi · Rp48.000 |
| 04/05/2026 | 4 porsi · Rp116.000 |
| 04/05/2026 | 4 porsi · Rp116.000 |
| 04/05/2026 | 20 porsi · Rp520.000 |
| 04/04/2026 | 5 porsi · Rp140.000 |
| 04/01/2026 | 20 porsi · Rp520.000 |
| 03/31/2026 | 5 porsi · Rp140.000 |
| 03/30/2026 | 20 porsi · Rp520.000 |
| 03/29/2026 | 2 porsi · Rp58.000 |
| 03/29/2026 | 40 porsi · Rp1.000.000 |
| 03/27/2026 | 20 porsi · Rp520.000 |
| 03/25/2026 | 5 porsi · Rp140.000 |
| 02/26/2026 | 10 porsi · Rp270.000 |
| 02/14/2026 | 25 porsi · Rp500.000 |
| 01/31/2026 | 6 porsi · Rp162.000 |
| 01/26/2026 | 40 porsi · Rp960.000 |
| 12/16/2025 | 75 porsi · Rp1.068.750 |

## B. ORDER_HARIAN — rows with BLANK / missing customer name

Deliveries that name no customer. They deduct from nobody and cannot be reconciled.

_None._

## C. ORDER_HARIAN — names with NO matching DB customer

These delivery rows are NOT deducted, so the named customer's remaining is overstated (or the customer is missing from the DB).

| Sheet name | Rows | Σ Porsi (delivered) | Likely DB match? |
|---|---|---|---|
| Jennifer PDN | 20 | 20 | Jennifer |
| Vini Tester | 1 | 9 | — (not in DB?) |
| Putri Reno | 4 | 8 | Putri |
| Daryn Dior | 6 | 6 | — (not in DB?) |
| Shella | 6 | 6 | Shella GS |
| Kevin | 4 | 4 | Kevin M |
| Jennifer Smith | 2 | 2 | Jennifer |
| Sherly WIjaya | 1 | 2 | — (not in DB?) |
| Syifa | 2 | 2 | — (not in DB?) |
| Gaylen (Influencer) | 1 | 1 | Valen |
| Jeennifer PDN | 1 | 1 | Jennifer SWO |
| 1 | 1 | 1 | — (not in DB?) |

## D. Other missing / suspicious data

### package_orders
- Real purchases missing a name (orphans, see A2): **24**
- Empty template/filler rows (ignored): **725**
- Named rows with Porsi = 0: **3** — reyhan (04/11/2026); Odelia (02/11/2026); Liza (02/03/2026)
- Suspicious Porsi > 500 (likely typo): **1** — Mario Montana: porsi=2000 (6/17/2026)

### ORDER_HARIAN
- Rows with unparseable date: **0**
- Rows with Porsi = 0: **0**
- Rows with blank / #N/A area: **349**

## How to fix

1. **Section A/C suggestions**: if "Likely DB match" is right, rename the sheet entry to match the DB exactly (or add an alias in `scripts/import-customers-orders.ts` → `NAME_ALIASES`).
2. **"not in DB?"**: the customer is missing — add them in the dashboard, or confirm they are non-customers (e.g. `panti`, `tambahan acara`).
3. **Section A2 orphan purchases**: fill the Nama column in package_orders so the quota credits a customer (24 purchases, incl. a 52-porsi / Rp1.560.000 row).
4. **Section D zeros/typos**: correct the Porsi cells (e.g. Mario Montana 2010 → 10).
5. Re-run this audit, then `--reconcile --dry-run` to confirm the numbers settle.
