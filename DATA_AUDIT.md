# Data Audit — package_orders / ORDER_HARIAN vs CUSTOMERS sheet

_Generated 2026-07-04. Re-run: `set -a && . ./.env.local && set +a && pnpm tsx scripts/audit-sheet-data.ts`_

CUSTOMERS sheet rows: **177** · package_orders rows: **1006** · ORDER_HARIAN rows: **3364**

## A. package_orders — names with NO matching customer in the CUSTOMERS sheet

These purchases are not counted toward any customer's quota. Either the customer is missing from the CUSTOMERS sheet, or the name is spelled differently.

_None._

## A2. package_orders — purchases with NO customer name (orphan purchases)

Rows that record a date / portions / amount but have a blank Nama. Real money/quota that belongs to nobody — cannot be credited to any customer.

_None._

## B. ORDER_HARIAN — rows with BLANK / missing customer name

Deliveries that name no customer. They deduct from nobody and cannot be reconciled.

_None._

## C. ORDER_HARIAN — names with NO matching customer in the CUSTOMERS sheet

These delivery rows are NOT deducted, so the named customer's remaining is overstated (or the customer is missing from the CUSTOMERS sheet).

_None._

## E. Computed remaining quota per customer (ignores Sisa Kuota column)

Remaining = Σ package_orders porsi − Σ ORDER_HARIAN porsi delivered on or before 2026-07-04, matched by CUSTOMERS sheet name. Names from A/C (unmatched rows) are excluded — fix those first, they are not counted here.

**26 customer(s) with negative computed remaining despite having logged purchases** (candidates for free/goodwill quota — see Section F):

| Customer | Purchased | Delivered | Remaining |
|---|---|---|---|
| Jennifer Valerie | 160 | 167 | -7 |
| Defi Lugito | 100 | 106 | -6 |
| Jennifer Theophilia Hartoyo | 40 | 45 | -5 |
| Herlina | 60 | 64 | -4 |
| Saput | 45 | 48 | -3 |
| Justin | 4 | 7 | -3 |
| Aiza | 20 | 23 | -3 |
| Darren | 30 | 33 | -3 |
| Aline | 66 | 68 | -2 |
| Ahmad Akbar | 20 | 22 | -2 |
| Jonathan R | 12 | 14 | -2 |
| Valen | 45 | 47 | -2 |
| Emilia | 20 | 22 | -2 |
| Natalia Saroso | 4 | 6 | -2 |
| Agustina | 5 | 7 | -2 |
| Nathaza Caroline | 2 | 4 | -2 |
| Dhila | 20 | 21 | -1 |
| Jennifer Gresia | 20 | 21 | -1 |
| Selma | 2 | 3 | -1 |
| Brandy | 11 | 12 | -1 |
| Angie | 5 | 6 | -1 |
| Dio Satria | 5 | 6 | -1 |
| Shinta S | 45 | 46 | -1 |
| Yasin | 20 | 21 | -1 |
| Radytia | 10 | 11 | -1 |
| Lysa | 12 | 13 | -1 |

**5 customer(s) with 0 logged purchases but deliveries exist** — package_orders was only backfilled from Dec 1, 2025 onward; these predate the backfill and are not a real deficit:

- Verick (delivered 83)
- Kiliang (delivered 11)
- Darren Dior (delivered 11)
- Kevin M (delivered 8)
- Gaylen (Influencer) (delivered 1)

<details><summary>Full computed remaining quota, all customers</summary>

| Customer | Purchased | Delivered | Remaining |
|---|---|---|---|
| Adam W | 5 | 5 | 0 |
| Adrian | 35 | 35 | 0 |
| Agnez | 3 | 3 | 0 |
| Agustina | 5 | 7 | -2 |
| Ahmad Akbar | 20 | 22 | -2 |
| Aiza | 20 | 23 | -3 |
| Aline | 66 | 68 | -2 |
| Ameera | 2 | 2 | 0 |
| Angelyn | 20 | 15 | 5 |
| Anggun | 5 | 4 | 1 |
| Angie | 5 | 6 | -1 |
| Arfan Polda Jambi | 52 | 0 | 52 |
| Ari Budiyanti | 3 | 3 | 0 |
| Ason | 2 | 0 | 2 |
| Audrey | 10 | 10 | 0 |
| Aurelia Shella | 3 | 0 | 3 |
| Aurellia Hanzelita | 4 | 4 | 0 |
| Berliana Chandra | 5 | 0 | 5 |
| Binsar Sirait | 16 | 14 | 2 |
| Brandon | 2 | 2 | 0 |
| Brandy | 11 | 12 | -1 |
| Cecilia | 5 | 5 | 0 |
| Charloz | 30 | 0 | 30 |
| Chintia | 2 | 2 | 0 |
| Christina | 5 | 5 | 0 |
| Christoper Tan | 10 | 6 | 4 |
| Claire Lina | 5 | 0 | 5 |
| Darren | 30 | 33 | -3 |
| Darren Dior | 0 | 11 | -11 |
| Daryn Dior | 16 | 5 | 11 |
| David | 26 | 26 | 0 |
| Defi Lugito | 100 | 106 | -6 |
| Devi | 10 | 10 | 0 |
| Dhila | 20 | 21 | -1 |
| Dio Satria | 5 | 6 | -1 |
| Diva Felicia | 11 | 10 | 1 |
| Drake | 40 | 30 | 10 |
| Dylan | 14 | 13 | 1 |
| Elaine | 40 | 6 | 34 |
| Eleazar | 90 | 0 | 90 |
| Ely | 10 | 9 | 1 |
| Emilia | 20 | 22 | -2 |
| Fabian | 5 | 5 | 0 |
| Fahmi | 15 | 14 | 1 |
| Fareen | 40 | 40 | 0 |
| Farrell Suryadi | 5 | 5 | 0 |
| Febby | 120 | 105 | 15 |
| Felicia | 20 | 19 | 1 |
| Felik Darmawan | 11 | 0 | 11 |
| Fenny | 1 | 0 | 1 |
| Ferlie | 46 | 45 | 1 |
| Fiana Agistha | 5 | 0 | 5 |
| Fikri | 20 | 12 | 8 |
| Floren | 1 | 1 | 0 |
| Galvent | 10 | 10 | 0 |
| Gandy Indrawan | 10 | 10 | 0 |
| Gaylen (Influencer) | 0 | 1 | -1 |
| Gita | 35 | 35 | 0 |
| Grace | 10 | 0 | 10 |
| Grace Kesuma | 5 | 5 | 0 |
| Grace Noviana | 5 | 5 | 0 |
| Grace Trinita | 4 | 4 | 0 |
| Gracia | 15 | 13 | 2 |
| Hanna | 40 | 34 | 6 |
| Herlina | 60 | 64 | -4 |
| Herlyna | 25 | 20 | 5 |
| Jason T | 15 | 10 | 5 |
| Jeanice | 4 | 2 | 2 |
| Jennifer Angela Widjaja | 3 | 3 | 0 |
| Jennifer Gresia | 20 | 21 | -1 |
| Jennifer Theophilia Hartoyo | 40 | 45 | -5 |
| Jennifer Valerie | 160 | 167 | -7 |
| Jesica Aftiani | 5 | 3 | 2 |
| Jessica Kam | 4 | 4 | 0 |
| Jocelyn | 12 | 0 | 12 |
| Jonathan Felix | 4 | 4 | 0 |
| Jonathan R | 12 | 14 | -2 |
| Julian | 20 | 20 | 0 |
| Juniadi | 3 | 3 | 0 |
| Justin | 4 | 7 | -3 |
| Katriel Scenny | 40 | 38 | 2 |
| Kayla | 20 | 19 | 1 |
| Kelvin | 10 | 8 | 2 |
| Keren Hana | 10 | 2 | 8 |
| Kevin Aurelio | 2 | 0 | 2 |
| Kevin M | 0 | 8 | -8 |
| Kezia WIjaya | 8 | 0 | 8 |
| Kiki Aristiawati | 20 | 0 | 20 |
| Kiliang | 0 | 11 | -11 |
| Kirei Rompah | 2 | 2 | 0 |
| Krissensia | 10 | 10 | 0 |
| Lani Diana | 12 | 8 | 4 |
| Lavi | 1 | 1 | 0 |
| Lee W | 38 | 36 | 2 |
| Lia | 1 | 1 | 0 |
| Liza | 10 | 10 | 0 |
| Lovely | 20 | 18 | 2 |
| Lysa | 12 | 13 | -1 |
| Madeline | 22 | 22 | 0 |
| Margaretha | 2 | 2 | 0 |
| Maria Dewita | 115 | 105 | 10 |
| Maria Marcella | 20 | 0 | 20 |
| Mariana | 1 | 1 | 0 |
| Mario Montana | 20 | 7 | 13 |
| Marv | 10 | 10 | 0 |
| Mega | 1 | 1 | 0 |
| Melati Muksin | 4 | 4 | 0 |
| Mellvy | 40 | 31 | 9 |
| Melvina | 105 | 95 | 10 |
| Meylisa | 2 | 2 | 0 |
| Michele Angela Mark | 5 | 5 | 0 |
| Miss Putri | 1 | 1 | 0 |
| Monica | 50 | 10 | 40 |
| Nabila | 110 | 60 | 50 |
| Nadita Putri | 60 | 59 | 1 |
| Nakita | 32 | 31 | 1 |
| Nana | 1 | 1 | 0 |
| Nani S | 1 | 1 | 0 |
| Natalia Saroso | 4 | 6 | -2 |
| Nathan | 3 | 3 | 0 |
| Nathaza Caroline | 2 | 4 | -2 |
| Nicholas Satria | 20 | 18 | 2 |
| Novia | 25 | 7 | 18 |
| Odelia | 1 | 1 | 0 |
| Olivia | 9 | 9 | 0 |
| Ona Apriana | 1 | 1 | 0 |
| Onny | 6 | 0 | 6 |
| Pak Lim | 56 | 12 | 44 |
| Putri | 10 | 8 | 2 |
| Rachael Angeline | 3 | 3 | 0 |
| Radytia | 10 | 11 | -1 |
| Rexana | 4 | 4 | 0 |
| Reyhan | 38 | 0 | 38 |
| Rissa | 17 | 17 | 0 |
| Riveren Elvina | 5 | 4 | 1 |
| Rowan | 24 | 0 | 24 |
| Rudy | 40 | 38 | 2 |
| Sally | 15 | 15 | 0 |
| Samuel (BIC) | 75 | 0 | 75 |
| Saput | 45 | 48 | -3 |
| Selma | 2 | 3 | -1 |
| Sensen | 6 | 0 | 6 |
| Shella Affandi | 17 | 16 | 1 |
| Sherly Wijaya | 2 | 2 | 0 |
| Shinta S | 45 | 46 | -1 |
| Sisil | 6 | 6 | 0 |
| Steven | 10 | 2 | 8 |
| Susy Dewi | 54 | 51 | 3 |
| Syifa | 2 | 2 | 0 |
| Taro | 5 | 5 | 0 |
| Tia | 61 | 59 | 2 |
| Tio Jason | 50 | 26 | 24 |
| Tjam | 85 | 75 | 10 |
| Valen | 45 | 47 | -2 |
| Vanessa | 38 | 0 | 38 |
| Vania | 80 | 61 | 19 |
| vania shabrina willi | 10 | 9 | 1 |
| Velisca | 45 | 44 | 1 |
| Verick | 0 | 83 | -83 |
| Vero | 35 | 30 | 5 |
| Veronica Catherine | 32 | 28 | 4 |
| Vidi | 10 | 10 | 0 |
| Vina | 8 | 8 | 0 |
| Vincent Halim | 19 | 19 | 0 |
| Vini | 9 | 9 | 0 |
| Vita | 8 | 8 | 0 |
| Vivi | 5 | 0 | 5 |
| Wendy | 20 | 0 | 20 |
| William | 12 | 2 | 10 |
| Yasin | 20 | 21 | -1 |
| Yos Prabowo | 8 | 8 | 0 |
| Zhoe | 10 | 9 | 1 |

</details>

## F. Free quota check — dates a customer's balance went negative

For each customer with a real deficit (has purchases, still over-delivered — Section E), walks purchase and delivery events in date order and flags each delivery date where the running balance drops below zero. Use this to find *when* a free/goodwill portion (e.g. late-delivery compensation) was likely given, so it can be logged. `Gaylen (Influencer)` is excluded — permanent 1-portion/month barter for endorsement content, not a data issue.

**Jennifer Valerie** — total deficit -7, 3 likely grant date(s):
- 2026-04-07 (balance goes 0 → -1)
- 2026-06-03 (balance goes 0 → -1)
- 2026-06-23 (balance goes 0 → -1)

**Defi Lugito** — total deficit -6, 1 likely grant date(s):
- 2026-06-26 (balance goes 0 → -2)

**Jennifer Theophilia Hartoyo** — total deficit -5, 2 likely grant date(s):
- 2025-12-29 (balance goes 0 → -1)
- 2026-01-29 (balance goes 0 → -1)

**Herlina** — total deficit -4, 1 likely grant date(s):
- 2026-03-03 (balance goes 0 → -1)

**Saput** — total deficit -3, 1 likely grant date(s):
- 2026-04-16 (balance goes 0 → -1)

**Justin** — total deficit -3, 1 likely grant date(s):
- 2026-06-17 (balance goes 0 → -1)

**Aiza** — total deficit -3, 1 likely grant date(s):
- 2026-06-17 (balance goes 0 → -1)

**Darren** — total deficit -3, 1 likely grant date(s):
- 2026-06-25 (balance goes 0 → -1)

**Aline** — total deficit -2, 1 likely grant date(s):
- 2026-05-06 (balance goes 0 → -1)

**Ahmad Akbar** — total deficit -2, 1 likely grant date(s):
- 2026-06-06 (balance goes 0 → -1)

**Jonathan R** — total deficit -2, 1 likely grant date(s):
- 2026-06-05 (balance goes 0 → -1)

**Valen** — total deficit -2, 1 likely grant date(s):
- 2026-06-25 (balance goes 0 → -1)

**Emilia** — total deficit -2, 3 likely grant date(s):
- 2026-05-08 (balance goes 3 → -2)
- 2026-05-11 (balance goes 4 → -2)
- 2026-05-13 (balance goes 1 → -2)

**Natalia Saroso** — total deficit -2, 1 likely grant date(s):
- 2026-06-10 (balance goes 1 → -2)

**Agustina** — total deficit -2, 1 likely grant date(s):
- 2026-06-08 (balance goes 0 → -1)

**Nathaza Caroline** — total deficit -2, 1 likely grant date(s):
- 2026-06-05 (balance goes 0 → -1)

**Dhila** — total deficit -1, 1 likely grant date(s):
- 2026-04-08 (balance goes 0 → -1)

**Jennifer Gresia** — total deficit -1, 1 likely grant date(s):
- 2026-03-04 (balance goes 0 → -1)

**Selma** — total deficit -1, 1 likely grant date(s):
- 2026-03-02 (balance goes 0 → -1)

**Brandy** — total deficit -1, 1 likely grant date(s):
- 2026-04-24 (balance goes 0 → -1)

**Angie** — total deficit -1, 1 likely grant date(s):
- 2026-06-01 (balance goes 0 → -1)

**Dio Satria** — total deficit -1, 1 likely grant date(s):
- 2026-06-03 (balance goes 0 → -1)

**Shinta S** — total deficit -1, 1 likely grant date(s):
- 2026-06-23 (balance goes 1 → -1)

**Yasin** — total deficit -1, 1 likely grant date(s):
- 2026-06-06 (balance goes 0 → -1)

**Radytia** — total deficit -1, 1 likely grant date(s):
- 2026-05-25 (balance goes 0 → -1)

**Lysa** — total deficit -1, 1 likely grant date(s):
- 2026-06-24 (balance goes 0 → -1)

## D. Other missing / suspicious data

### package_orders
- Real purchases missing a name (orphans, see A2): **0**
- Empty template/filler rows (ignored): **711**
- Named rows with Porsi = 0: **0**
- Suspicious Porsi > 500 (likely typo): **0**

### ORDER_HARIAN
- Rows with unparseable date: **0**
- Rows with Porsi = 0: **0**
- Rows with blank / #N/A area: **1**

## How to fix

1. **Section A/C suggestions**: if "Likely match" is right, rename the sheet entry to match the CUSTOMERS sheet exactly (or add an alias in `scripts/import-customers-orders.ts` → `NAME_ALIASES`).
2. **"not in sheet?"**: the customer is missing from CUSTOMERS — add them there, or confirm they are non-customers (e.g. `panti`, `tambahan acara`).
3. **Section A2 orphan purchases**: fill the Nama column in package_orders so the quota credits a customer.
4. **Section D zeros/typos**: correct the Porsi cells.
5. **Section E**: negative remaining means over-delivered vs purchases, or a purchase row is still unmatched (fix A first) — this replaces the Sisa Kuota column as the trusted number.
6. Re-run this audit, then `--reconcile --dry-run` to confirm the numbers settle.
