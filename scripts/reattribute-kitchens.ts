/**
 * Puts the right kitchen on every delivery row from 2026-01-01 to 2026-07-31.
 *
 * The June import read the operations sheet's `subcontractor` column, which is a
 * VLOOKUP that had already broken: it answers "Thenie" for 2220 of its rows and
 * #N/A for another 1062. So 2484 delivery rows carry Thenie and only 105 carry
 * anyone else, while the bank shows nine kitchens being paid over the same
 * months. COGS, the kitchen bills and every per-kitchen margin are wrong.
 *
 * The sheet's own `cogs_per_portion` column is not part of that VLOOKUP and is
 * the real fingerprint: each kitchen charged a distinct rate, and the daily bank
 * debits confirm the rate and its date window to the rupiah. A kitchen is paid
 * on day D for the food it cooks on day D+1, so a payment names both a rate and
 * a portion count — Thenie's Rp 129.000 on 19 May is 6 x Rp 21.000 plus Rp 3.000
 * ongkir, and the sheet has exactly 6 portions at Rp 21.000 on the 20th.
 *
 *   Thenie          Rp 20.000 to 2026-03-28, Rp 21.000 from 2026-03-29,
 *                   plus Rp 3.000 ongkir a day from 2026-04-27
 *   Santapin        Rp 20.000, Rp 19.500 from 2026-02-20
 *   Perut Bahagia   Rp 21.000 (bank name "Aris Wibisono")
 *   Yuk Makan       Rp 23.000, Rp 27.000 for size M (bank "Stefano Mario Supit")
 *   Pangkha         Rp 21.000 then Rp 23.000 (bank name "Fenti Afriltia")
 *   Hanvin          Rp 22.000 (bank name "Elvina Puspita Dewi")
 *   Cendana         Rp 18.000 (bank name "Grace Sinthike Kewas")
 *
 * Rp 21.000 and Rp 23.000 are each cooked by more than one kitchen, so the money
 * has to say who. Comparing every day's rate groups against the previous day's
 * debits cuts the year into windows where exactly one kitchen was paid:
 *
 *   Rp 21.000  Thenie owns it outright from 2026-03-29, and its payment equals
 *              the group to the rupiah on 31 of the 34 days to 6 May. Two
 *              windows break that: 7-15 May, where Pangkha is paid Rp 2.085.000
 *              while Thenie's exact share drops to 5-7 portions of a 41-portion
 *              group, and 5-18 June, where Thenie is paid nothing at all and
 *              Perut Bahagia is paid Rp 7.127.000 against 343 portions
 *              (Rp 20.778 each). From 19 June Thenie's payments cover the whole
 *              group again.
 *
 *   Rp 23.000  starts 13 May. Yuk Makan's bills tie exactly — Rp 418.000 on
 *              24 May is 17 x 23.000 + 1 x 27.000 for the 25th, Rp 353.000 is
 *              the 30th, Rp 629.000 the 2nd of June, Rp 621.000 the 4th. The
 *              exceptions are 14 and 15 May, which Pangkha's last two bills
 *              (Rp 800.000 and Rp 887.000) pay for.
 *
 *   Rp 20.000  before 2026-03-29 is Thenie *and* Santapin, and there the rate
 *              column cannot separate them at all. They are the only two
 *              kitchens paid in that window and the daily totals close, so each
 *              day is a subset-sum over that day's customers for Thenie's paid
 *              portion count. A customer in every exact subset is Thenie's for
 *              certain and one in none of them is Santapin's for certain; the
 *              rest are settled by which customers Thenie demonstrably had in
 *              April, and counted separately in the report as inferred.
 *
 *              From 2026-03-29 the whole group is Santapin's: Rp 13.249.000 paid
 *              against 668 portions is Rp 19.834 each, and most days are an
 *              exact multiple of Rp 19.500.
 *
 * Not everything reconciles. 177 portions at Rp 23.000 over 16-24 May have no
 * matching debit in any imported statement — the money left by some other route
 * — and they are attributed to Yuk Makan on window alone. The report says so.
 *
 *   pnpm exec tsx --env-file=.env.local scripts/reattribute-kitchens.ts
 *   pnpm exec tsx --env-file=.env.local scripts/reattribute-kitchens.ts --apply
 *
 * Dry run by default.
 */
import { logEdit, systemActor } from "../src/lib/audit/log-edit";
import { createAdminClient } from "../src/lib/supabase/admin";

const SHEET_ID = "13cKpPcqdqXTpqWrWL5sDiZVNrYClzSBcrypO_CPZTgI";
const ORDER_HARIAN_GID = "1975392427";
const WINDOW_START = "2026-01-01";
const WINDOW_END = "2026-07-31";

const KITCHEN = {
  thenie: "52cd5e62-da09-49c9-939c-2f1246566c40",
  santapin: "f06fd140-26e1-49cf-ba2e-dadf521913a3",
  yukMakan: "1ea4e72d-94e4-46a5-b0f1-de605417185f",
  perutBahagia: "2f0035e2-dd00-4b1f-be15-4a11d0f2e240",
  pangkha: "c791d6b9-d309-477e-a915-bf3cc29f5c58",
  hanvin: "ffff1951-b622-4282-a0bd-595c9945e2ec",
  cendana: "66f2d320-0aad-4466-a355-2126a80f50f9",
} as const;
const NAME: Record<string, string> = {
  [KITCHEN.thenie]: "Thenie",
  [KITCHEN.santapin]: "Santapin",
  [KITCHEN.yukMakan]: "Yuk Makan",
  [KITCHEN.perutBahagia]: "Perut Bahagia",
  [KITCHEN.pangkha]: "Pangkha",
  [KITCHEN.hanvin]: "Hanvin",
  [KITCHEN.cendana]: "Cendana",
};

/**
 * How each kitchen spells itself in the bank. Thenie's and Santapin's streams
 * are what separate the two shared rates; the rest are here so the report can
 * put what we attributed to a kitchen beside what we actually paid it.
 */
const PAYEE: Record<string, keyof typeof KITCHEN> = {
  "R Bg Andreas Kurnianto": "thenie",
  "Pembayaran ke Thenie Catering": "thenie",
  "Pembayaran ke Santapin Catering": "santapin",
  "Catering Santapin": "santapin",
  "Aris Wibisono": "perutBahagia",
  "Stefano Mario Supit": "yukMakan",
  "Fenti Afriltia": "pangkha",
  "Elvina Puspita Dewi": "hanvin",
  "Grace Sinthike Kewas": "cendana",
};

/** Thenie's rate change, and the day Santapin takes the whole Rp 20.000 group. */
const THENIE_RATE_FROM = "2026-03-29";
/** Thenie's payment covers part of the Rp 21.000 group; Pangkha cooks the rest. */
const PANGKHA_21K = { from: "2026-05-07", to: "2026-05-15" };
/** Pangkha's last two bills, the only Rp 23.000 days that are not Yuk Makan's. */
const PANGKHA_23K = { from: "2026-05-14", to: "2026-05-15" };
/** Thenie is paid nothing and Perut Bahagia takes the whole Rp 21.000 group. */
const PERUT_21K = { from: "2026-06-05", to: "2026-06-18" };
/** The first Rp 23.000 row in the sheet. */
const YUK_MAKAN_FROM = "2026-05-13";
/** Rp 27.000 is Yuk Makan's size M — Rp 23.000 plus `settings.size_m_surcharge`. */
const SIZE_M = 27000;

type Window = { from: string; to: string };
const within = (date: string, w: Window) => date >= w.from && date <= w.to;

const ACTOR = systemActor("reattribute-kitchens");
const apply = process.argv.includes("--apply");

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** The sheet writes dates m/d/yyyy. */
function toIso(cell: string): string | null {
  const m = cell.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}
function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
const key = (date: string, name: string, meal: string) =>
  `${date}|${name.trim().toLowerCase()}|${meal.trim().toLowerCase()}`;

type SheetRow = { date: string; name: string; meal: string; portions: number; rate: number };
type Deliv = {
  id: string;
  delivery_date: string;
  meal_type: string;
  portions: number;
  subcontractor_id: string | null;
  name: string;
};

async function loadSheet(): Promise<SheetRow[]> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${ORDER_HARIAN_GID}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sheet ${res.status}`);
  const rows = parseCsv(await res.text());
  const head = rows[0].map((h) => h.trim());
  const col = (n: string) => head.indexOf(n);
  const [cDate, cMeal, cName, cPort, cCogs] = [
    col("date"),
    col("Lunch/Dinner"),
    col("name"),
    col("portion"),
    col("cogs_per_portion"),
  ];
  const out: SheetRow[] = [];
  for (const r of rows.slice(1)) {
    const date = toIso(r[cDate] ?? "");
    if (!date || date < WINDOW_START || date > WINDOW_END) continue;
    const rate = Number((r[cCogs] ?? "").replace(/[^0-9]/g, ""));
    out.push({
      date,
      name: r[cName] ?? "",
      meal: r[cMeal] ?? "",
      portions: Math.round(Number(r[cPort] ?? 0)) || 0,
      rate: Number.isFinite(rate) ? rate : 0,
    });
  }
  return out;
}

async function loadPayments(db: ReturnType<typeof createAdminClient>) {
  const paid: Record<string, Map<string, number>> = {};
  for (const k of Object.keys(KITCHEN)) paid[k] = new Map<string, number>();
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("bank_transactions")
      .select("txn_date, direction, amount, counterparty")
      .gte("txn_date", "2025-12-01")
      .lte("txn_date", WINDOW_END)
      .order("txn_date")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const t of data ?? []) {
      if (t.direction !== "DB") continue;
      const who = PAYEE[(t.counterparty ?? "").trim()];
      if (!who) continue;
      const m = paid[who];
      m.set(t.txn_date, (m.get(t.txn_date) ?? 0) + Math.round(Number(t.amount)));
    }
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return paid;
}

async function loadDeliveries(db: ReturnType<typeof createAdminClient>): Promise<Deliv[]> {
  const out: Deliv[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("daily_deliveries")
      .select("id, delivery_date, meal_type, portions, subcontractor_id, customers!inner(name)")
      .gte("delivery_date", WINDOW_START)
      .lte("delivery_date", WINDOW_END)
      .order("delivery_date")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? [])
      out.push({
        id: r.id,
        delivery_date: r.delivery_date,
        meal_type: r.meal_type,
        portions: r.portions,
        subcontractor_id: r.subcontractor_id,
        name: (r.customers as unknown as { name: string }).name ?? "",
      });
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

/**
 * A payment is portions x rate, plus Rp 3.000 ongkir once a day from 27 April.
 * Anything else is a part payment and we take what it covers.
 */
function portionsCovered(amount: number, rate: number): number {
  if (amount <= 0) return 0;
  if (amount % rate === 0) return amount / rate;
  if (amount > 3000 && (amount - 3000) % rate === 0) return (amount - 3000) / rate;
  return Math.floor(amount / rate);
}

type Cust = { name: string; portions: number };

/**
 * Which customers appear in *every* subset that sums to `target`, and which
 * appear in none. Those two answers are facts about the day; everyone else is
 * interchangeable as far as the money can tell, and needs the prior to settle.
 *
 * Two sweeps of the usual subset-sum table — sums reachable from the left of
 * customer j, sums reachable from the right of it — say whether j can be in a
 * solution and whether j can be out of one.
 */
function forcedMembership(cust: Cust[], target: number) {
  const n = cust.length;
  const reach = (items: Cust[]) => {
    const table: Uint8Array[] = [new Uint8Array(target + 1)];
    table[0][0] = 1;
    for (let i = 0; i < items.length; i++) {
      const next = new Uint8Array(target + 1);
      const p = items[i].portions;
      for (let r = 0; r <= target; r++) {
        if (!table[i][r]) continue;
        next[r] = 1;
        if (r + p <= target) next[r + p] = 1;
      }
      table.push(next);
    }
    return table;
  };
  const left = reach(cust);
  const right = reach([...cust].reverse());
  if (!left[n][target]) return null;
  const always = new Set<string>();
  const never = new Set<string>();
  for (let j = 0; j < n; j++) {
    const p = cust[j].portions;
    const after = right[n - 1 - j];
    let canIn = false;
    let canOut = false;
    for (let r = 0; r <= target && !(canIn && canOut); r++) {
      if (!left[j][r]) continue;
      if (r + p <= target && after[target - r - p]) canIn = true;
      if (after[target - r]) canOut = true;
    }
    if (canIn && !canOut) always.add(cust[j].name);
    else if (canOut && !canIn) never.add(cust[j].name);
  }
  return { always, never };
}

/**
 * Pick the customers whose portions add up to exactly `target`, preferring the
 * ones we already believe belong to that kitchen. Returns null when no subset
 * adds up.
 */
function subsetSum(cust: Cust[], target: number, prior: Map<string, number>): Set<string> | null {
  if (target === 0) return new Set();
  const order = [...cust].sort(
    (a, b) => (prior.get(b.name) ?? 0.15) - (prior.get(a.name) ?? 0.15) || a.name.localeCompare(b.name),
  );
  const suffix = new Array(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + order[i].portions;
  let best: { score: number; pick: Set<string> } | null = null;
  const walk = (i: number, rest: number, picked: string[], score: number) => {
    if (rest === 0) {
      if (!best || score > best.score) best = { score, pick: new Set(picked) };
      return;
    }
    if (i >= order.length || rest < 0 || rest > suffix[i]) return;
    const c = order[i];
    walk(i + 1, rest - c.portions, [...picked, c.name], score + (prior.get(c.name) ?? 0.15));
    walk(i + 1, rest, picked, score - (prior.get(c.name) ?? 0.15));
  };
  walk(0, target, [], 0);
  return best ? (best as { pick: Set<string> }).pick : null;
}

async function main() {
  const db = createAdminClient();
  const [sheet, paid, deliveries] = await Promise.all([
    loadSheet(),
    loadPayments(db),
    loadDeliveries(db),
  ]);

  const rateOf = new Map<string, number>();
  const sheetByDay = new Map<string, SheetRow[]>();
  for (const r of sheet) {
    rateOf.set(key(r.date, r.name, r.meal), r.rate);
    const list = sheetByDay.get(r.date) ?? [];
    list.push(r);
    sheetByDay.set(r.date, list);
  }
  /** That day's customers at one rate, portions summed, names lowercased. */
  const groupAt = (rows: SheetRow[], rate: number): Cust[] => {
    const by = new Map<string, number>();
    for (const r of rows) {
      if (r.rate !== rate) continue;
      const n = r.name.trim().toLowerCase();
      by.set(n, (by.get(n) ?? 0) + r.portions);
    }
    return [...by].map(([name, portions]) => ({ name, portions }));
  };

  // Thenie's customers in April, when it was the only kitchen on Rp 21.000.
  // This is what seeds the Jan-Mar subset-sum and orders the 7-15 May split.
  const thenieSeed = new Set<string>();
  for (const r of sheet)
    if (r.rate === 21000 && r.date >= THENIE_RATE_FROM && r.date < PANGKHA_21K.from)
      thenieSeed.add(r.name.trim().toLowerCase());

  // --- Jan 1 - Mar 28: Thenie and Santapin share Rp 20.000. ---------------
  // What the money settles on its own, before any prior is applied.
  const certainThenie = new Map<string, Set<string>>();
  const certainSantapin = new Map<string, Set<string>>();
  const noSubset = new Set<string>();
  for (const [date, rows] of sheetByDay) {
    if (date >= THENIE_RATE_FROM) continue;
    const cust = [...groupAt(rows, 20000), ...groupAt(rows, 19500)];
    const target = portionsCovered(paid.thenie.get(dayBefore(date)) ?? 0, 20000);
    const forced = forcedMembership(cust, target);
    if (!forced) {
      noSubset.add(date);
      continue;
    }
    certainThenie.set(date, forced.always);
    certainSantapin.set(date, forced.never);
  }

  const prior = new Map<string, number>();
  for (const n of thenieSeed) prior.set(n, 0.85);
  let janMar = new Map<string, Set<string>>();
  for (let pass = 0; pass < 8; pass++) {
    const picked = new Map<string, Set<string>>();
    const seen = new Map<string, number>();
    const hit = new Map<string, number>();
    for (const [date, rows] of sheetByDay) {
      if (date >= THENIE_RATE_FROM || noSubset.has(date)) continue;
      const cust = [...groupAt(rows, 20000), ...groupAt(rows, 19500)];
      const target = portionsCovered(paid.thenie.get(dayBefore(date)) ?? 0, 20000);
      const pick = subsetSum(cust, target, prior) ?? new Set<string>();
      picked.set(date, pick);
      for (const c of cust) {
        seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
        if (pick.has(c.name)) hit.set(c.name, (hit.get(c.name) ?? 0) + 1);
      }
    }
    for (const [n, total] of seen)
      prior.set(
        n,
        0.7 * (((hit.get(n) ?? 0) + 0.5) / (total + 1)) + 0.3 * (thenieSeed.has(n) ? 0.85 : 0.15),
      );
    janMar = picked;
  }

  // --- 7-15 May: Thenie's payment names its share, Pangkha cooks the rest. -
  const theniePangkhaDays = new Map<string, Set<string>>();
  for (const [date, rows] of sheetByDay) {
    if (!within(date, PANGKHA_21K)) continue;
    const cust = groupAt(rows, 21000);
    const covered = portionsCovered(paid.thenie.get(dayBefore(date)) ?? 0, 21000);
    const order = [...cust].sort(
      (a, b) =>
        Number(thenieSeed.has(b.name)) - Number(thenieSeed.has(a.name)) ||
        b.portions - a.portions ||
        a.name.localeCompare(b.name),
    );
    const pick = new Set<string>();
    let left = covered;
    for (const c of order) {
      if (left <= 0) break;
      if (c.portions <= left) {
        pick.add(c.name);
        left -= c.portions;
      }
    }
    theniePangkhaDays.set(date, pick);
  }

  // --- Decide every delivery row. ----------------------------------------
  type Plan = { row: Deliv; to: string; why: string };
  const planned: Plan[] = [];
  const unchanged: Plan[] = [];
  const skipped: { row: Deliv; why: string }[] = [];
  for (const row of deliveries) {
    const n = row.name.trim().toLowerCase();
    const d = row.delivery_date;
    const rate = rateOf.get(key(d, row.name, row.meal_type));
    if (rate === undefined) {
      skipped.push({ row, why: "no matching sheet row" });
      continue;
    }
    let to: string;
    let why: string;
    if (rate === 22000) {
      to = KITCHEN.hanvin;
      why = "rate 22.000";
    } else if (rate === 18000) {
      to = KITCHEN.cendana;
      why = "rate 18.000";
    } else if (rate === 23000 || rate === SIZE_M) {
      if (within(d, PANGKHA_23K)) {
        to = KITCHEN.pangkha;
        why = "rate 23.000, Pangkha's last two bills";
      } else if (d >= YUK_MAKAN_FROM) {
        to = KITCHEN.yukMakan;
        why = "rate 23.000, Yuk Makan's window";
      } else {
        skipped.push({ row, why: `rate ${rate} before any kitchen cooked at it` });
        continue;
      }
    } else if (rate === 21000) {
      if (within(d, PERUT_21K)) {
        to = KITCHEN.perutBahagia;
        why = "rate 21.000, the fortnight Perut Bahagia was paid and Thenie was not";
      } else if (within(d, PANGKHA_21K)) {
        to = theniePangkhaDays.get(d)?.has(n) ? KITCHEN.thenie : KITCHEN.pangkha;
        why = "rate 21.000, split by Thenie's payment that day";
      } else {
        to = KITCHEN.thenie;
        why = "rate 21.000, Thenie's own";
      }
    } else if (rate === 20000 || rate === 19500) {
      if (d >= THENIE_RATE_FROM) {
        to = KITCHEN.santapin;
        why = "rate 20.000 after Thenie moved to 21.000";
      } else if (noSubset.has(d)) {
        skipped.push({ row, why: "no subset of that day matches Thenie's payment" });
        continue;
      } else if (certainThenie.get(d)?.has(n)) {
        to = KITCHEN.thenie;
        why = "rate 20.000, in every subset matching Thenie's payment";
      } else if (certainSantapin.get(d)?.has(n)) {
        to = KITCHEN.santapin;
        why = "rate 20.000, in no subset matching Thenie's payment";
      } else {
        const mine = janMar.get(d)?.has(n) ?? false;
        to = mine ? KITCHEN.thenie : KITCHEN.santapin;
        why = `rate 20.000, inferred ${mine ? "Thenie" : "Santapin"} from April's customer set`;
      }
    } else {
      skipped.push({ row, why: `rate ${rate || "blank"} matches no kitchen` });
      continue;
    }
    (to === row.subcontractor_id ? unchanged : planned).push({ row, to, why });
  }

  // --- Report. -----------------------------------------------------------
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  for (const r of deliveries) {
    const b = r.subcontractor_id ? (NAME[r.subcontractor_id] ?? r.subcontractor_id) : "(none)";
    before.set(b, (before.get(b) ?? 0) + r.portions);
  }
  const moved = new Map(planned.map((p) => [p.row.id, p.to]));
  for (const r of deliveries) {
    const id = moved.get(r.id) ?? r.subcontractor_id;
    const a = id ? (NAME[id] ?? id) : "(none)";
    after.set(a, (after.get(a) ?? 0) + r.portions);
  }
  console.log(`${deliveries.length} delivery rows ${WINDOW_START}..${WINDOW_END}`);
  console.log(
    `${planned.length} rows change kitchen, ${unchanged.length} already right, ${skipped.length} left alone\n`,
  );
  console.log("portions by kitchen        before      after");
  for (const k of new Set([...before.keys(), ...after.keys()]))
    console.log(
      `  ${k.padEnd(22)} ${String(before.get(k) ?? 0).padStart(6)} ${String(after.get(k) ?? 0).padStart(10)}`,
    );

  // What each kitchen's portions cost against what the bank actually paid it.
  const RATE_OF: Record<string, number[]> = {
    Thenie: [20000, 21000],
    Santapin: [19500, 20000],
    "Perut Bahagia": [21000],
    "Yuk Makan": [23000, SIZE_M],
    Pangkha: [21000, 23000],
    Hanvin: [22000],
    Cendana: [18000],
  };
  const owed = new Map<string, number>();
  for (const p of [...planned, ...unchanged]) {
    const k = NAME[p.to];
    const rate = rateOf.get(key(p.row.delivery_date, p.row.name, p.row.meal_type)) ?? 0;
    if (!RATE_OF[k]?.includes(rate)) continue;
    owed.set(k, (owed.get(k) ?? 0) + p.row.portions * rate);
  }
  // The point of the whole exercise: what we say each kitchen cooked, against
  // what the bank says we paid it over the same months.
  // July is shown on its own because the sheet stopped being maintained then:
  // Thenie's July bills imply 16-30 portions a day against 2-15 rows on the
  // sheet, so July's shortfall is missing rows, not a wrong kitchen.
  const payTotal = (from: string, to: string) => {
    const m = new Map<string, number>();
    for (const [k, days] of Object.entries(paid)) {
      let sum = 0;
      for (const [d, amount] of days) if (d >= dayBefore(from) && d < to) sum += amount;
      m.set(NAME[KITCHEN[k as keyof typeof KITCHEN]], sum);
    }
    return m;
  };
  const rupiah = (v: number) => `Rp ${v.toLocaleString("id-ID")}`;
  const paidJanJun = payTotal(WINDOW_START, "2026-07-01");
  const paidJul = payTotal("2026-07-01", WINDOW_END);
  console.log("\nattributed x rate     Jan-Jun paid      of it   Jul paid");
  for (const k of new Set([...owed.keys(), ...paidJanJun.keys()])) {
    const a = owed.get(k) ?? 0;
    const b = paidJanJun.get(k) ?? 0;
    const j = paidJul.get(k) ?? 0;
    const pct = b ? `${Math.round((a / b) * 100)}%` : "";
    console.log(
      `  ${k.padEnd(14)} ${rupiah(a).padStart(14)} ${rupiah(b).padStart(14)} ${pct.padStart(6)} ${(j ? rupiah(j) : "").padStart(14)}`,
    );
  }

  const reasons = new Map<string, number>();
  for (const p of planned) reasons.set(p.why, (reasons.get(p.why) ?? 0) + 1);
  console.log("\nwhy");
  for (const [w, c] of [...reasons].sort((a, b) => b[1] - a[1]))
    console.log(`  ${c.toString().padStart(4)}  ${w}`);
  const left = new Map<string, number>();
  for (const s of skipped) left.set(s.why, (left.get(s.why) ?? 0) + 1);
  console.log("\nleft alone");
  for (const [w, c] of [...left].sort((a, b) => b[1] - a[1]))
    console.log(`  ${c.toString().padStart(4)}  ${w}`);

  if (!apply) {
    console.log("\nDry run. Pass --apply to write.");
    return;
  }
  let written = 0;
  for (const p of planned) {
    const { error } = await db
      .from("daily_deliveries")
      .update({ subcontractor_id: p.to })
      .eq("id", p.row.id);
    if (error) {
      console.error(`${p.row.id}: ${error.message}`);
      continue;
    }
    written++;
    await logEdit({
      db,
      actor: ACTOR,
      entityType: "daily_delivery",
      entityId: p.row.id,
      action: "update",
      changes: {
        subcontractor_id: { from: p.row.subcontractor_id, to: p.to },
        why: p.why,
      },
    });
  }
  console.log(`\n${written} rows written.`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : JSON.stringify(e));
    process.exit(1);
  },
);
