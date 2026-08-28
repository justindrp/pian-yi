# Overdraw — customers who ate more than they bought

Generated 2026-08-14 by `scripts/export-overdraw.ts`.

**32 customers, 178 portions over.**

Format: `[name] +[bought] -[drawn] [balance]`. `bought` counts non-cancelled
orders including any free-quota grants already recorded. Customers sharing a
package via `linked_order_id` are folded into the package owner's line.

```
Verick +0 -83 -83
Kiliang +0 -11 -11
Nakita +32 -41 -9
Kevin M +0 -8 -8
Jennifer Valerie +160 -167 -7
Jennifer Theophilia Hartoyo +40 -46 -6
Defi Lugito +100 -106 -6
Valen +45 -49 -4
Tia +61 -65 -4
Herlina +60 -64 -4
PT Bintang Lautan Sejahtera +110 -113 -3
Saput +45 -48 -3
Aiza +20 -23 -3
Darren +30 -33 -3
Aline +66 -68 -2
Ahmad Akbar +20 -22 -2
Jonathan R +12 -14 -2
Emilia +20 -22 -2
Natalia Saroso +4 -6 -2
Nathaza Caroline +2 -4 -2
Brandy +11 -12 -1
vania shabrina willi +10 -11 -1
Angie +5 -6 -1
Agustina +6 -7 -1
Yasin +20 -21 -1
Radytia +10 -11 -1
Gaylen (Influencer) +0 -1 -1
Jennifer Gresia +20 -21 -1
Dhila +20 -21 -1
Lysa +12 -13 -1
Dio Satria +5 -6 -1
Selma +2 -3 -1
```

## Detail

| Customer | Bought | Drawn | Balance | Last delivery | Notes |
|---|---:|---:|---:|---|---|
| Verick | 0 | 83 | -83 | 2026-03-13 | no purchases on file |
| Kiliang | 0 | 11 | -11 | 2026-01-12 | no purchases on file |
| Nakita | 32 | 41 | -9 | 2026-07-24 |  |
| Kevin M | 0 | 8 | -8 | 2026-03-13 | no purchases on file |
| Jennifer Valerie | 160 | 167 | -7 | 2026-06-26 |  |
| Jennifer Theophilia Hartoyo | 40 | 46 | -6 | 2026-05-15 |  |
| Defi Lugito | 100 | 106 | -6 | 2026-06-30 |  |
| Valen | 45 | 49 | -4 | 2026-07-03 |  |
| Tia | 61 | 65 | -4 | 2026-07-08 |  |
| Herlina | 60 | 64 | -4 | 2026-03-05 |  |
| PT Bintang Lautan Sejahtera | 110 | 113 | -3 | 2026-08-14 |  |
| Saput | 45 | 48 | -3 | 2026-04-16 |  |
| Aiza | 20 | 23 | -3 | 2026-06-19 |  |
| Darren | 30 | 33 | -3 | 2026-06-26 |  |
| Aline | 66 | 68 | -2 | 2026-05-07 |  |
| Ahmad Akbar | 20 | 22 | -2 | 2026-06-08 |  |
| Jonathan R | 12 | 14 | -2 | 2026-06-05 |  |
| Emilia | 20 | 22 | -2 | 2026-05-13 |  |
| Natalia Saroso | 4 | 6 | -2 | 2026-06-10 |  |
| Nathaza Caroline | 2 | 4 | -2 | 2026-06-05 |  |
| Brandy | 11 | 12 | -1 | 2026-04-24 |  |
| vania shabrina willi | 10 | 11 | -1 | 2026-07-03 |  |
| Angie | 5 | 6 | -1 | 2026-06-01 |  |
| Agustina | 6 | 7 | -1 | 2026-06-09 |  |
| Yasin | 20 | 21 | -1 | 2026-06-06 |  |
| Radytia | 10 | 11 | -1 | 2026-05-25 |  |
| Gaylen (Influencer) | 0 | 1 | -1 | 2026-01-23 | no purchases on file |
| Jennifer Gresia | 20 | 21 | -1 | 2026-03-04 |  |
| Dhila | 20 | 21 | -1 | 2026-04-08 |  |
| Lysa | 12 | 13 | -1 | 2026-06-24 |  |
| Dio Satria | 5 | 6 | -1 | 2026-06-03 |  |
| Selma | 2 | 3 | -1 | 2026-03-02 |  |

## Reading this

4 customers have no purchases on file at all (Verick -83, Kiliang -11, Kevin M -8, Gaylen (Influencer) -1). Verick, Kiliang and Kevin M last ate before the December package_orders backfill, so theirs are missing purchase records rather than granted quota. Gaylen is the exception: 1 portion bartered for a promo video, so hers is a genuine grant that has never been recorded as a free_quota order.

No draw path checks the balance before writing, so the small 1-2 portion
balances are as likely to be the missing guard as a deliberate grant. Free
quota should only be recorded where it is independently verified.
