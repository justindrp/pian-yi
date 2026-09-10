/**
 * Rebuilds the September–December 2025 delivery history and the package
 * purchases behind it.
 *
 * The database's own history starts in December 2025: orders were imported from
 * the BCA e-statements from 2025-12-01 onwards, and delivery rows from the
 * Jan–Jun tab of the operations spreadsheet, which begins 2025-12-29. Everything
 * before that was missing on both sides — 2281 portions eaten and roughly
 * Rp 49 million of packages bought — which is why 51 customers carried a quota
 * balance they had in fact eaten years ago (task 909d72bf).
 *
 * Two sources rebuild it:
 *   1. the pre-January tab of the operations sheet — one row per portion, with
 *      the eater's name, the date and lunch/dinner;
 *   2. the BCA e-statements for 2025-09 .. 2025-12 — the money, which is the
 *      only record of what each customer bought.
 *
 * The payer on a transfer is often not the eater (a parent, a middleman, a
 * housemate), so the join between the two is a hand-curated map in
 * `scripts/data/backfill-2025-mapping.json`, with the evidence for every row
 * written down beside it. Package sizes come from
 * `scripts/data/backfill-2025-sizes.json`, derived from the ladder the December
 * orders already in the database were priced on.
 *
 *   pnpm exec tsx --env-file=.env.local scripts/backfill-2025-history.ts
 *   pnpm exec tsx --env-file=.env.local scripts/backfill-2025-history.ts --apply
 *   ... --why <name>              one eater's orders and who paid each
 *   ... --orders [from] [to]      every order it would write, oldest first
 *
 * Dry run by default. It prints every customer, order and delivery row it would
 * write and the balance each customer ends up with.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseStatementPdf } from "../src/lib/accounting/statement-parser";
import { logEdit, systemActor } from "../src/lib/audit/log-edit";
import { createAdminClient } from "../src/lib/supabase/admin";

const SHEET_ID = "13cKpPcqdqXTpqWrWL5sDiZVNrYClzSBcrypO_CPZTgI";
const PRE_JAN_GID = "650194403";
/** The Jan–Jun tab starts 2025-12-29 and is already imported, so we stop here. */
const WINDOW_START = "2025-09-01";
const WINDOW_END = "2025-12-28";
/**
 * We cooked our own food until 2025-12-14; Thenie is the first partner kitchen
 * and takes over from that date. So a 2025 row's kitchen is decided by its own
 * date — 2212 of the 2281 portions here were cooked in-house and carry no
 * subcontractor at all.
 */
const THENIE = "52cd5e62-da09-49c9-939c-2f1246566c40";
const THENIE_FROM = "2025-12-14";
const kitchenOn = (date: string) => (date >= THENIE_FROM ? THENIE : null);
const STATEMENTS = [
  "BCA_2025_09.pdf",
  "BCA_2025_10.pdf",
  "BCA_2025_11.pdf",
  "BCA_2025_12.pdf",
].map((f) => path.join(process.env.HOME ?? "", "Desktop", "Pian Yi", f));

/** Not customer money: our own float, refunds, card interchange, interest. */
const NOT_A_PAYMENT =
  /KREDIFAZZ|DANIEL RAHARDYAN|DOMPET ANAK BANGSA|INTERCHANGE GOOGLE|INOVASI TERDEPAN/i;

const ACTOR = systemActor("backfill-2025-history");
const apply = process.argv.includes("--apply");

type Mapping = {
  eaters: Record<
    string,
    {
      customer: string | null;
      payers: string[];
      confidence: "high" | "medium" | "low" | "none";
      kind?: "free_quota";
      /**
       * Portions the sheet never recorded. The sheet was barely kept in its
       * first fortnight — 9 to 14 September carries one name — so a payment
       * with no row against it is as often a gap in the sheet as an unclaimed
       * balance. A delivery named here is one Justin has confirmed happened.
       */
      deliveries?: { date: string; meal: "lunch" | "dinner"; portions: number }[];
      why?: string;
    }
  >;
  /**
   * Credits that land in the account but buy no Pian Yi package: event orders,
   * another kitchen's people, staff, refunds, personal transfers. They are not
   * unknowns and must not sit in the unmatched list pretending to be, but they
   * are not eaters either — writing them as packages would create exactly the
   * phantom quota this backfill exists to remove. Matched, reported by kind,
   * and left for the journal backfill, which is where they belong.
   */
  nonCustomer: {
    match: string;
    kind: string;
    /** Contra account the journal line will face. */
    account: string;
    why: string;
    /** `event_order` only: who the event was for, and how big it was. */
    customer?: string;
    portions?: number | null;
    /** An order the database already holds for this event; reused, not doubled. */
    existingOrderId?: string;
    /**
     * Restricts the rule to one debit. A payer with several events sizes each
     * one separately, and a rule that names an amount is tried before the bare
     * name rule that would otherwise swallow all of them.
     */
    amount?: number;
    /** Where the sheet records the event, when it is not the day after payment. */
    deliveryDate?: string;
    meal?: "lunch" | "dinner";
    /**
     * An event is tendered, so its rate is a negotiated figure and not the
     * debit divided by the portions: a deposit, a second instalment and a
     * delivery fee all move the amount away from what was actually agreed.
     * Set both together, from what Justin quoted, or leave both unset and the
     * debit is taken at face value.
     */
    rate?: number;
    orderTotal?: number;
    /**
     * Ongkir folded into the payment. It is a pass-through and belongs in 2101,
     * not in 4001, so the journal backfill splits it off. It is not part of
     * `orderTotal`.
     */
    deliveryFee?: number;
  }[];
};
type Debit = {
  date: string;
  amount: number;
  counterparty: string;
  memo: string;
};
type SheetRow = { date: string; name: string; meal: "lunch" | "dinner" };

// --- sources ---------------------------------------------------------------

/** Quote-aware CSV split; the sheet's Catatan column is full of commas. */
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

/** The sheet writes dates as M/D/YYYY. */
function toIso(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

async function loadSheet(): Promise<SheetRow[]> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${PRE_JAN_GID}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sheet fetch failed: ${res.status}`);
  const rows = parseCsv(await res.text());
  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const [cDate, cMeal, cName] = [
    col("Tanggal"),
    col("Lunch/Dinner"),
    col("Nama"),
  ];
  if (cDate < 0 || cMeal < 0 || cName < 0)
    throw new Error(`sheet columns moved: ${header.join(",")}`);

  const out: SheetRow[] = [];
  for (const r of rows.slice(1)) {
    const date = toIso(r[cDate] ?? "");
    const name = (r[cName] ?? "").trim().replace(/\s+/g, " ");
    if (!date || !name) continue;
    if (date < WINDOW_START || date > WINDOW_END) continue;
    out.push({
      date,
      name,
      meal: /lunch/i.test(r[cMeal] ?? "") ? "lunch" : "dinner",
    });
  }
  return out;
}

async function loadDebits(): Promise<Debit[]> {
  const out: Debit[] = [];
  for (const file of STATEMENTS) {
    const statements = await parseStatementPdf(
      new Uint8Array(await readFile(file)),
    );
    for (const s of statements) {
      if (s.currency !== "IDR") continue;
      // Money in is what this script is built from, and it ties exactly in
      // all four files; `controlTotalsOk` is false for October and November
      // because each drops one money-out line, which no order comes from.
      //
      // The statement's own column for money in is headed CR — the bank is
      // describing its liability to us, not our books. In our ledger the same
      // line debits 1002 Bank BCA, and a debit is what it is called
      // everywhere the script speaks to a person.
      if (
        s.totalCredit !== s.statedCredit ||
        s.creditCount !== s.statedCreditCount
      )
        throw new Error(
          `${path.basename(file)}: parsed debits ${s.totalCredit} × ${s.creditCount} do not match the statement's ${s.statedCredit} × ${s.statedCreditCount}`,
        );
      for (const l of s.lines) {
        if (l.direction !== "CR") continue;
        const counterparty = l.counterparty ?? "";
        const memo = trimFooter(l.rawText.replace(/\s+/g, " "));
        if (NOT_A_PAYMENT.test(counterparty) || NOT_A_PAYMENT.test(memo))
          continue;
        if (/^BUNGA|GoPay Bank Transfe/i.test(memo)) continue;
        if (l.txnDate < WINDOW_START || l.txnDate > WINDOW_END) continue;
        out.push({ date: l.txnDate, amount: l.amount, counterparty, memo });
      }
    }
  }
  return out;
}

// --- name handling ---------------------------------------------------------

/**
 * BCA prints the account holder's own name and address into the last entry on a
 * page. Left in place it swallows the real payer's name and trips
 * NOT_A_PAYMENT, which silently dropped real customer debits.
 */
function trimFooter(raw: string): string {
  const cut = raw.search(
    /K C U B U|C A T A T A N|DANIEL RAHARDYAN PRAMADYO SEKT/,
  );
  return cut < 0 ? raw : raw.slice(0, cut).trim();
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Spelling variants only; never merges two people who share a first name. */
const SPELLING: Record<string, string> = {
  jocelryn: "Jocelyn",
  "jasaon therawan": "Jason Therawan",
  "jason t": "Jason Therawan",
  "kezia w": "Kezia Wijaya",
  "viona k": "Viona Kay",
  glady: "Glady Calista",
  // The sheet writes the event's host, the statement writes his full name.
  "timothy emery": "Timothy Emery Hart",
};

const canonical = (name: string) => SPELLING[norm(name)] ?? name;

const slug = (s: string) => norm(s).replace(/ /g, "_");

/**
 * Finds which mapped payer sent a debit.
 *
 * The parsed `counterparty` is unreliable: BCA files an inbound transfer from
 * another bank as "/DBS MOBILE" or "INDONESIA", and occasionally runs the next
 * line's text into it. The payer's name is always somewhere in the raw entry
 * though, so the map is searched against that instead. A payer may also be
 * written `NAME/MM-DD` in the map, which pins one specific payment when the
 * same person paid several times for different people.
 */
function findPayer(
  c: Debit,
  payers: { key: string; re: RegExp; date: string | null; eater: string }[],
): string | undefined {
  const hay = norm(`${c.counterparty} ${c.memo}`);
  const day = c.date.slice(5);
  // A date-pinned entry wins over a bare name for the same payer.
  for (const p of payers) if (p.date === day && p.re.test(hay)) return p.eater;
  for (const p of payers) if (p.date === null && p.re.test(hay)) return p.eater;
  return undefined;
}

// --- money -----------------------------------------------------------------

type Sizes = { byAmount: Record<string, number> };

function packageSize(sizes: Sizes, amount: number): number | null {
  return sizes.byAmount[String(amount)] ?? null;
}

// --- main ------------------------------------------------------------------

type Plan = {
  eater: string;
  customerId: string | null;
  customerName: string;
  createCustomer: boolean;
  phone: string;
  eaten: number;
  orders: {
    date: string;
    size: number;
    rate: number;
    total: number;
    payer: string;
    free: boolean;
    /** Already in the database from the December import; not written again. */
    dup: boolean;
  }[];
  existingBought: number;
  existingEaten: number;
  /**
   * Deliveries that come from a payment rather than from the daily sheet. A
   * one-off event is cooked on one date and never appears on the subscription
   * sheet, so nothing else would ever eat its portions.
   */
  eventDeliveries: { date: string; meal: string; portions: number }[];
  /** Positional against `orders`; an id here is reused instead of inserted. */
  reuseOrderIds: (string | undefined)[];
};

/** BCA books an evening transfer on the day it lands; the food is the next day. */
function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const db = createAdminClient();
  const here = path.dirname(new URL(import.meta.url).pathname);
  const mapping: Mapping = JSON.parse(
    await readFile(path.join(here, "data/backfill-2025-mapping.json"), "utf8"),
  );
  const sizes: Sizes = JSON.parse(
    await readFile(path.join(here, "data/backfill-2025-sizes.json"), "utf8"),
  );

  const sheet = await loadSheet();
  const debits = await loadDebits();
  console.log(
    `sheet: ${sheet.length} portions ${WINDOW_START}..${WINDOW_END} | statements: ${debits.length} customer debits\n`,
  );

  // Every mapped payer, longest name first so a specific one is tried before a
  // shorter name it contains.
  const payers = Object.entries(mapping.eaters).flatMap(([eater, m]) =>
    m.payers.map((raw) => {
      const [name, day] = raw.split("/");
      const n = norm(name);
      if (n.length < 5)
        throw new Error(`payer "${raw}" is too short to match on safely`);
      // Whole words only: "NATHAN" must not match "NATHANIEL DARREN M".
      return {
        key: raw,
        norm: n,
        re: new RegExp(`\\b${n.replace(/ /g, "\\s+")}\\b`),
        date: day ?? null,
        eater,
      };
    }),
  );
  payers.sort((a, b) => b.norm.length - a.norm.length);

  // Same haystack and the same whole-word rule as the payer map, so a name the
  // bank ran into the next line's text still matches.
  const nonCustomer = (mapping.nonCustomer ?? [])
    .map((r) => ({
      ...r,
      re: new RegExp(`\\b${norm(r.match).replace(/ /g, "\\s+")}\\b`),
    }))
    // A rule that names an amount is the specific one; try it before the bare
    // name rule that matches every debit the same payer sent.
    .sort((a, b) => (b.amount ? 1 : 0) - (a.amount ? 1 : 0));

  // --- customers ----------------------------------------------------------
  const { data: allCustomers } = await db
    .from("customers")
    .select("id, name, phone_number")
    .range(0, 999);
  const byName = new Map<string, { id: string; name: string; phone: string }>();
  for (const c of allCustomers ?? [])
    if (c.name)
      byName.set(norm(c.name), {
        id: c.id,
        name: c.name,
        phone: c.phone_number,
      });

  const eatenBy = new Map<string, number>();
  for (const r of sheet) {
    const e = canonical(r.name);
    eatenBy.set(e, (eatenBy.get(e) ?? 0) + 1);
  }

  const plans: Plan[] = [];
  for (const [eater, m] of Object.entries(mapping.eaters)) {
    const existing = m.customer ? byName.get(norm(m.customer)) : undefined;
    if (m.customer && !existing)
      throw new Error(`mapping names customer "${m.customer}", which is gone`);
    plans.push({
      eater,
      customerId: existing?.id ?? null,
      customerName: existing?.name ?? eater,
      createCustomer: !existing,
      phone: existing?.phone ?? `IMPORT_${slug(eater)}`,
      eaten: eatenBy.get(eater) ?? 0,
      orders: [],
      existingBought: 0,
      existingEaten: 0,
      eventDeliveries: (m.deliveries ?? []).map((d) => ({ ...d })),
      reuseOrderIds: [],
    });
  }
  for (const p of plans)
    p.eaten += p.eventDeliveries.reduce((s, d) => s + d.portions, 0);

  // --- orders from the statements -----------------------------------------
  const unmatched: Debit[] = [];
  const excluded: { debit: Debit; rule: Mapping["nonCustomer"][number] }[] =
    [];
  const unpriced: Debit[] = [];
  const surcharges: Debit[] = [];
  for (const c of debits) {
    const rule = nonCustomer.find(
      (r) =>
        (r.amount === undefined || r.amount === c.amount) &&
        r.re.test(norm(`${c.counterparty} ${c.memo}`)),
    );
    if (rule) {
      excluded.push({ debit: c, rule });
      continue;
    }
    const eater = findPayer(c, payers);
    if (!eater) {
      unmatched.push(c);
      continue;
    }
    // Below one portion at the cheapest rate this is an ongkir top-up or a
    // rounding transfer, never a package.
    if (c.amount < 20000) {
      surcharges.push(c);
      continue;
    }
    const size = packageSize(sizes, c.amount);
    if (size === null) {
      unpriced.push(c);
      continue;
    }
    const plan = plans.find((p) => p.eater === eater);
    if (!plan) throw new Error(`payer maps to unknown eater ${eater}`);
    plan.orders.push({
      date: c.date,
      size,
      rate: Math.round(c.amount / size),
      total: c.amount,
      payer: c.counterparty || eater,
      free: false,
      dup: false,
    });
  }

  // --- one-off events ------------------------------------------------------
  // These never touch the daily sheet, so the sheet can never eat what they
  // bought. Give each one its own order and its own delivery, a day after the
  // payment, and the pair nets to zero instead of leaving a balance nobody
  // holds. A payer whose event size is still unknown is held back whole.
  const eventUnsized: { debit: Debit; match: string }[] = [];
  for (const { debit: c, rule } of excluded) {
    if (rule.kind !== "event_order") continue;
    if (!rule.customer) throw new Error(`event rule ${rule.match} names no customer`);
    if (!rule.portions) {
      eventUnsized.push({ debit: c, match: rule.match });
      continue;
    }
    const existing = byName.get(norm(rule.customer));
    let plan = plans.find((x) => x.eater === rule.customer);
    if (!plan) {
      plan = {
        eater: rule.customer,
        customerId: existing?.id ?? null,
        customerName: existing?.name ?? rule.customer,
        createCustomer: !existing,
        phone: existing?.phone ?? `IMPORT_${slug(rule.customer)}`,
        eaten: 0,
        orders: [],
        existingBought: 0,
        existingEaten: 0,
        eventDeliveries: [],
        reuseOrderIds: [],
      };
      plans.push(plan);
    }
    plan.orders.push({
      date: c.date,
      size: rule.portions,
      rate: rule.rate ?? Math.round(c.amount / rule.portions),
      total: rule.orderTotal ?? c.amount,
      payer: c.counterparty || rule.customer,
      free: false,
      dup: false,
    });
    // An order the database already holds is matched, never counted twice.
    if (rule.existingOrderId) plan.orders[plan.orders.length - 1].dup = true;
    plan.reuseOrderIds.push(rule.existingOrderId);
    plan.eventDeliveries.push({
      date: rule.deliveryDate ?? nextDay(c.date),
      meal: rule.meal ?? "lunch",
      portions: rule.portions,
    });
    plan.eaten += rule.portions;
  }

  // An event that also got written on the daily sheet is one row standing for
  // the whole event — "Timothy Emery, 66 porsi event gereja" is a single line
  // for 66 portions. Counting it as well as the event's own delivery would
  // both inflate the row by one portion and leave the eater one short, so the
  // event wins and the sheet row is dropped wherever the two coincide.
  const eventKeys = new Set(
    plans.flatMap((p) =>
      p.eventDeliveries.map((d) => `${p.eater}|${d.date}|${d.meal}`),
    ),
  );
  const sheetRows = sheet.filter(
    (r) => !eventKeys.has(`${canonical(r.name)}|${r.date}|${r.meal}`),
  );
  for (const p of plans) {
    const rows = sheetRows.filter((r) => canonical(r.name) === p.eater).length;
    p.eaten =
      rows + p.eventDeliveries.reduce((sum, d) => sum + d.portions, 0);
  }

  // --- what the database already holds ------------------------------------
  for (const p of plans) {
    if (!p.customerId) continue;
    const { data: os } = await db
      .from("orders")
      .select("package_size, status, start_date, total_price")
      .eq("customer_id", p.customerId);
    const live = (os ?? []).filter(
      (o) => !String(o.status).startsWith("cancelled"),
    );
    p.existingBought = live.reduce((s, o) => s + (o.package_size ?? 0), 0);
    // The December import already turned some of these same debits into
    // orders; those are matched, not written twice. Its start_date came from
    // the first delivery rather than the transfer, so it can sit a day or two
    // either side — BCA books an evening transfer on the following day.
    const claimed = new Set<number>();
    for (const o of p.orders) {
      const i = live.findIndex(
        (h, idx) =>
          !claimed.has(idx) &&
          h.total_price === o.total &&
          Math.abs(Date.parse(h.start_date) - Date.parse(o.date)) <=
            3 * 86400000,
      );
      if (i >= 0) {
        claimed.add(i);
        o.dup = true;
      }
    }
    const { data: ds } = await db
      .from("daily_deliveries")
      .select("portions")
      .eq("customer_id", p.customerId);
    p.existingEaten = (ds ?? []).reduce((s, d) => s + d.portions, 0);
  }

  // An order exists because money arrived. Nothing else may create one.
  //
  // This block used to close a customer's gap by inventing an order for the
  // shortfall at Rp 26.000 so the ledger netted to zero instead of going
  // negative, and that is backwards: it manufactured Rp 787.000 of revenue
  // across 30 orders that no debit supports, and it hid the two things worth
  // knowing — a payer we have not identified yet, and a mapping that sends one
  // person's money to the wrong eater. Jane Mariana's four transfers were
  // split across Drake and Rivans, which left Rivans 40 portions short, and
  // the invented order swallowed the discrepancy silently instead of
  // reporting it. Portions eaten with no money behind them are now listed in
  // the report and nothing is written for them.
  //
  // The two internal eaters are the exception and not really one: a staff meal
  // has no payment because nobody paid, so it is granted at Rp 0.
  const uncovered: {
    eater: string;
    short: number;
    eaten: number;
    covered: number;
    first: string;
    last: string;
  }[] = [];
  for (const p of plans) {
    const m = mapping.eaters[p.eater];
    // Event plans have no eater entry: their portions came from the payment,
    // not from the sheet, and are already balanced by their own delivery row.
    if (!m) continue;
    const free = m.kind === "free_quota";
    const covered =
      p.existingBought -
      p.existingEaten +
      p.orders.reduce((s, o) => s + o.size, 0);
    const short = p.eaten - (free ? 0 : covered);
    if (short <= 0) continue;
    const rows = sheet.filter((r) => canonical(r.name) === p.eater);
    const first = rows[0]?.date;
    if (!first) continue;
    if (!free) {
      uncovered.push({
        eater: p.eater,
        short,
        eaten: p.eaten,
        covered,
        first,
        last: rows[rows.length - 1]?.date ?? first,
      });
      continue;
    }
    p.orders.push({
      date: first,
      size: short,
      rate: 0,
      total: 0,
      payer: "(free portions)",
      free,
      dup: false,
    });
  }

  // --- report -------------------------------------------------------------
  // Event deliveries are not sheet rows, so the sheet's own totals miss them.
  const eventPortions = plans.reduce(
    (t, p) => t + p.eventDeliveries.reduce((s, d) => s + d.portions, 0),
    0,
  );
  const eventRows = new Set(
    plans.flatMap((p) =>
      p.eventDeliveries.map((d) => `${d.date}|${p.eater}|${d.meal}`),
    ),
  ).size;
  console.log(
    "eater                    cust  2025 bought  2025 eaten | already bought  already ate | balance after",
  );
  let bought2025 = 0;
  let money2025 = 0;
  for (const p of [...plans].sort((a, b) => b.eaten - a.eaten)) {
    const fresh = p.orders.filter((o) => !o.dup);
    const buy = fresh.reduce((s, o) => s + o.size, 0);
    const money = fresh.reduce((s, o) => s + o.total, 0);
    bought2025 += buy;
    money2025 += money;
    const balance = p.existingBought + buy - (p.existingEaten + p.eaten);
    console.log(
      `${p.eater.padEnd(24)} ${(p.createCustomer ? "NEW " : "have").padEnd(5)} ${String(buy).padStart(11)} ${String(p.eaten).padStart(11)} | ${String(p.existingBought).padStart(14)} ${String(p.existingEaten).padStart(12)} | ${String(balance).padStart(13)}`,
    );
  }
  console.log(
    `\ncustomers to create: ${plans.filter((p) => p.createCustomer).length}` +
      ` | orders to create: ${plans.reduce((s, p) => s + p.orders.filter((o) => !o.dup).length, 0)}` +
      ` | portions bought: ${bought2025} for Rp ${money2025.toLocaleString("id-ID")}` +
      ` | portions eaten: ${sheet.length + eventPortions}` +
      ` in ${new Set(sheet.map((r) => `${r.date}|${canonical(r.name)}|${r.meal}`)).size + eventRows} delivery rows`,
  );

  if (surcharges.length) {
    console.log(
      `\n${surcharges.length} debits under Rp 20.000 totalling Rp ${surcharges.reduce((s, c) => s + c.amount, 0).toLocaleString("id-ID")} read as ongkir top-ups — no order:`,
    );
    for (const c of surcharges)
      console.log(
        `  ${c.date}  Rp ${String(c.amount).padStart(9)}  ${c.counterparty}`,
      );
  }

  // `--why <name>` prints one customer's working: every order and its payer.
  const why = process.argv[process.argv.indexOf("--why") + 1];
  if (process.argv.includes("--why")) {
    for (const p of plans.filter((x) => norm(x.eater).includes(norm(why)))) {
      console.log(
        `\n${p.eater} (${p.customerName}${p.createCustomer ? ", new" : ""})`,
      );
      for (const o of p.orders)
        console.log(
          `  ${o.date}  ${String(o.size).padStart(3)}p  Rp ${String(o.total).padStart(9)}  ${o.dup ? "already in DB" : "NEW         "}  ${o.payer}`,
        );
    }
  }

  // `--orders [from] [to]` prints every order the run would write, oldest
  // first, with who ate and who paid — the two names are different for a
  // sixth of them and the payer is the only thing the bank line carries.
  if (process.argv.includes("--orders")) {
    const i = process.argv.indexOf("--orders");
    const from = process.argv[i + 1] ?? WINDOW_START;
    const to = process.argv[i + 2] ?? WINDOW_END;
    const rows = plans
      .flatMap((p) => p.orders.map((o) => ({ ...o, eater: p.eater, plan: p })))
      .filter((o) => o.date >= from && o.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
    console.log(
      `\n${rows.length} orders ${from}..${to}, oldest first:\n` +
        "date        portions        total  status         customer                  payer",
    );
    for (const o of rows)
      console.log(
        `${o.date}  ${String(o.size).padStart(5)}p  Rp ${String(o.total).padStart(9)}  ` +
          `${(o.dup ? "already in DB" : "new").padEnd(13)}  ` +
          `${o.plan.customerName.padEnd(24)}  ${o.payer}`,
      );
    const fresh = rows.filter((o) => !o.dup);
    console.log(
      `  ${fresh.length} new, ${rows.length - fresh.length} already in DB;` +
        ` ${fresh.reduce((s, o) => s + o.size, 0)} portions` +
        ` for Rp ${fresh.reduce((s, o) => s + o.total, 0).toLocaleString("id-ID")}`,
    );
  }

  if (uncovered.length) {
    const short = uncovered.reduce((t, u) => t + u.short, 0);
    console.log(
      `\n${uncovered.length} eaters ate ${short} portions no debit pays for — nothing is written for these:`,
    );
    for (const u of [...uncovered].sort((a, b) => b.short - a.short))
      console.log(
        `  ${u.eater.padEnd(24)} ate ${String(u.eaten).padStart(4)}, bought ${String(u.covered).padStart(4)}, short ${String(u.short).padStart(4)}  ${u.first}..${u.last}`,
      );
    console.log(
      "  either the payer is not in the map, their money is mapped to another eater, or they paid in cash",
    );
  }

  if (unpriced.length) {
    console.log(
      `\n${unpriced.length} mapped debits have no package size — add them to backfill-2025-sizes.json:`,
    );
    for (const c of unpriced)
      console.log(
        `  ${c.date}  Rp ${String(c.amount).padStart(9)}  ${c.counterparty}  ${c.memo.slice(0, 60)}`,
      );
  }

  if (excluded.length) {
    const byKind = new Map<string, { n: number; sum: number; account: string }>();
    for (const e of excluded) {
      const k = byKind.get(e.rule.kind) ?? {
        n: 0,
        sum: 0,
        account: e.rule.account,
      };
      k.n += 1;
      k.sum += e.debit.amount;
      byKind.set(e.rule.kind, k);
    }
    const total = excluded.reduce((s, e) => s + e.debit.amount, 0);
    console.log(
      `\n${excluded.length} debits totalling Rp ${total.toLocaleString("id-ID")} are identified but buy no subscription package:`,
    );
    for (const [kind, k] of [...byKind].sort((a, b) => b[1].sum - a[1].sum))
      console.log(
        `  ${kind.padEnd(20)} ${String(k.n).padStart(2)} ${k.n === 1 ? "debit " : "debits"} Rp ${k.sum.toLocaleString("id-ID").padStart(11)}  -> ${k.account}${kind === "event_order" ? "  (order + delivery written)" : ""}`,
      );
    console.log(
      "  every kind but event_order is left to the journal backfill; this script writes nothing for them",
    );
  }

  if (eventUnsized.length) {
    console.log(
      `\n${eventUnsized.length} event debits totalling Rp ${eventUnsized.reduce((s, e) => s + e.debit.amount, 0).toLocaleString("id-ID")} have no portion count, so no order and no delivery is written:`,
    );
    for (const e of eventUnsized)
      console.log(
        `  ${e.debit.date}  Rp ${String(e.debit.amount).padStart(9)}  ${e.match}`,
      );
  }

  if (unmatched.length) {
    console.log(
      `\n${unmatched.length} debits totalling Rp ${unmatched.reduce((s, c) => s + c.amount, 0).toLocaleString("id-ID")} are not in the map — no order is written for these:`,
    );
    for (const c of unmatched)
      console.log(
        `  ${c.date}  Rp ${String(c.amount).padStart(9)}  ${c.counterparty}`,
      );
  }

  // The residual snapshot batch of 2026-07-04 exists only because this history
  // was missing: each row is "quota this customer still seems to hold". Now
  // that the purchases behind it are back, those rows double-count. They are
  // left alone here — deleting an order is not this script's job — but the
  // overlap is worth seeing.
  const residual: string[] = [];
  for (const p of plans) {
    if (!p.customerId) continue;
    const { data: os } = await db
      .from("orders")
      .select("id, package_size, total_price, created_at, status")
      .eq("customer_id", p.customerId)
      .gte("created_at", "2026-07-04")
      .lt("created_at", "2026-07-05");
    // An order this run reuses on purpose is not a snapshot duplicate.
    const reused = new Set(p.reuseOrderIds.filter(Boolean));
    for (const o of os ?? [])
      if (o.package_size && !reused.has(o.id))
        residual.push(
          `  ${p.eater.padEnd(20)} ${String(o.package_size).padStart(4)}p  Rp ${String(o.total_price).padStart(9)}  ${o.status}  ${o.id.slice(0, 8)}`,
        );
  }
  if (residual.length) {
    console.log(
      `\n${residual.length} residual snapshot orders of 2026-07-04 now sit on top of the rebuilt history and double-count:`,
    );
    for (const r of residual) console.log(r);
  }

  if (!apply) {
    console.log("\nDry run. Nothing written. Re-run with --apply.");
    return;
  }
  await write(db, plans, sheetRows);
}

async function write(
  db: ReturnType<typeof createAdminClient>,
  plans: Plan[],
  sheet: SheetRow[],
) {
  // 1. customers
  for (const p of plans.filter((x) => x.createCustomer)) {
    const { data, error } = await db
      .from("customers")
      .insert({ name: p.eater, phone_number: p.phone })
      .select("id")
      .single();
    if (error) throw new Error(`customer ${p.eater}: ${error.message}`);
    p.customerId = data.id;
    await logEdit({
      db,
      actor: ACTOR,
      entityType: "customer",
      entityId: data.id,
      action: "created",
      changes: { name: p.eater, phone_number: p.phone, from: "2025 backfill" },
    });
  }

  // 2. orders — skipping any the December import already wrote
  const orderIds = new Map<string, string[]>();
  for (const p of plans) {
    if (!p.customerId) continue;
    const { data: have } = await db
      .from("orders")
      .select("id, start_date, total_price")
      .eq("customer_id", p.customerId);
    const ids: string[] = [];
    for (const o of p.orders.sort((a, b) => a.date.localeCompare(b.date))) {
      const reuse = p.reuseOrderIds[p.orders.indexOf(o)];
      if (reuse) {
        ids.push(reuse);
        continue;
      }
      const dup = (have ?? []).find(
        (h) => h.start_date === o.date && h.total_price === o.total,
      );
      if (dup) {
        ids.push(dup.id);
        continue;
      }
      const { data, error } = await db
        .from("orders")
        .insert({
          customer_id: p.customerId,
          package_size: o.size,
          // Not a fact we have for 2025; every eater took one meal at a time.
          portions_per_delivery: 1,
          price_per_portion: o.rate,
          total_price: o.total,
          start_date: o.date,
          status: "completed",
          source: o.free ? "free_quota" : "purchase",
          grant_reason: o.free ? "internal — free portions" : null,
          granted_by: o.free ? ACTOR : null,
          subcontractor_id: kitchenOn(o.date),
          paid_at: o.free ? null : `${o.date}T00:00:00+07:00`,
          confirmed_at: `${o.date}T00:00:00+07:00`,
        })
        .select("id")
        .single();
      if (error)
        throw new Error(`order ${p.eater} ${o.date}: ${error.message}`);
      ids.push(data.id);
      await logEdit({
        db,
        actor: ACTOR,
        entityType: "order",
        entityId: data.id,
        action: "created",
        changes: { ...o, eater: p.eater, from: "2025 backfill" },
      });
    }
    orderIds.set(p.eater, ids);
  }

  // 3. deliveries — the sheet is one row per portion, the table is one row per
  //    (date, customer, meal), so they have to be summed first.
  const byKey = new Map<
    string,
    { p: Plan; date: string; meal: string; portions: number }
  >();
  for (const r of sheet) {
    const eater = canonical(r.name);
    const plan = plans.find((x) => x.eater === eater);
    if (!plan?.customerId) throw new Error(`no customer for ${eater}`);
    const key = `${r.date}|${plan.customerId}|${r.meal}`;
    const e = byKey.get(key) ?? {
      p: plan,
      date: r.date,
      meal: r.meal,
      portions: 0,
    };
    e.portions++;
    byKey.set(key, e);
  }

  // A one-off event's delivery comes from its payment, not from the sheet. It
  // goes through the same map so that two events for one person on one day
  // become one row rather than colliding on the (date, customer, meal) key.
  for (const plan of plans) {
    for (const d of plan.eventDeliveries) {
      if (!plan.customerId) throw new Error(`no customer for ${plan.eater}`);
      const key = `${d.date}|${plan.customerId}|${d.meal}`;
      const e = byKey.get(key) ?? {
        p: plan,
        date: d.date,
        meal: d.meal,
        portions: 0,
      };
      e.portions += d.portions;
      byKey.set(key, e);
    }
  }

  const rows = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
  // Charge each delivery to the oldest order of that customer with quota left,
  // and once those run out to the last one — never floor a per-order balance.
  const drawn = new Map<string, number>();
  const payload = rows.map((r) => {
    const ids = orderIds.get(r.p.eater) ?? [];
    let orderId = ids[ids.length - 1] ?? null;
    for (const id of ids) {
      const used = drawn.get(id) ?? 0;
      const size = r.p.orders[ids.indexOf(id)]?.size ?? 0;
      if (used + r.portions <= size) {
        orderId = id;
        break;
      }
    }
    if (orderId) drawn.set(orderId, (drawn.get(orderId) ?? 0) + r.portions);
    return {
      delivery_date: r.date,
      customer_id: r.p.customerId,
      order_id: orderId,
      meal_type: r.meal,
      portions: r.portions,
      subcontractor_id: kitchenOn(r.date),
      address_slot: 1,
    };
  });

  for (let i = 0; i < payload.length; i += 200) {
    const { error } = await db
      .from("daily_deliveries")
      .upsert(payload.slice(i, i + 200), {
        onConflict: "delivery_date,customer_id,meal_type",
      });
    if (error) throw new Error(`deliveries ${i}: ${error.message}`);
  }

  await logEdit({
    db,
    actor: ACTOR,
    entityType: "import",
    entityId: "backfill-2025-history",
    action: "completed",
    changes: {
      window: `${WINDOW_START}..${WINDOW_END}`,
      customers_created: plans.filter((p) => p.createCustomer).length,
      orders: [...orderIds.values()].flat().length,
      delivery_rows: payload.length,
      portions: sheet.length,
    },
  });

  console.log(
    `\nWrote ${payload.length} delivery rows covering ${payload.reduce((s, r) => s + r.portions, 0)} portions.`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  },
);
