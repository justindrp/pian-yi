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
      why?: string;
    }
  >;
};
type Credit = {
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

async function loadCredits(): Promise<Credit[]> {
  const out: Credit[] = [];
  for (const file of STATEMENTS) {
    const statements = await parseStatementPdf(
      new Uint8Array(await readFile(file)),
    );
    for (const s of statements) {
      if (s.currency !== "IDR") continue;
      // Only the credit side matters here, and it ties exactly in all four
      // files; `controlTotalsOk` is false for October and November because each
      // drops one debit line, which no order is built from.
      if (
        s.totalCredit !== s.statedCredit ||
        s.creditCount !== s.statedCreditCount
      )
        throw new Error(
          `${path.basename(file)}: parsed credits ${s.totalCredit} × ${s.creditCount} do not match the statement's ${s.statedCredit} × ${s.statedCreditCount}`,
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
 * NOT_A_PAYMENT, which silently dropped real customer credits.
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
};

const canonical = (name: string) => SPELLING[norm(name)] ?? name;

const slug = (s: string) => norm(s).replace(/ /g, "_");

/**
 * Finds which mapped payer sent a credit.
 *
 * The parsed `counterparty` is unreliable: BCA files an inbound transfer from
 * another bank as "/DBS MOBILE" or "INDONESIA", and occasionally runs the next
 * line's text into it. The payer's name is always somewhere in the raw entry
 * though, so the map is searched against that instead. A payer may also be
 * written `NAME/MM-DD` in the map, which pins one specific payment when the
 * same person paid several times for different people.
 */
function findPayer(
  c: Credit,
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
};

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
  const credits = await loadCredits();
  console.log(
    `sheet: ${sheet.length} portions ${WINDOW_START}..${WINDOW_END} | statements: ${credits.length} customer credits\n`,
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
    });
  }

  // --- orders from the statements -----------------------------------------
  const unmatched: Credit[] = [];
  const unpriced: Credit[] = [];
  const surcharges: Credit[] = [];
  for (const c of credits) {
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
    // The December import already turned some of these same credits into
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

  // Portions we know were eaten but cannot tie to a transfer: a free grant for
  // the two internal eaters, and for everyone else an order for the shortfall,
  // so the ledger nets to zero rather than going negative. A customer whose
  // existing orders already cover what they ate needs nothing.
  for (const p of plans) {
    const m = mapping.eaters[p.eater];
    const free = m.kind === "free_quota";
    const covered =
      p.existingBought -
      p.existingEaten +
      p.orders.reduce((s, o) => s + o.size, 0);
    const short = p.eaten - (free ? 0 : covered);
    if (short <= 0) continue;
    const first = sheet.filter((r) => canonical(r.name) === p.eater)[0]?.date;
    if (!first) continue;
    p.orders.push({
      date: first,
      size: short,
      rate: free ? 0 : 26000,
      total: free ? 0 : short * 26000,
      payer: free ? "(free portions)" : "(no payment found)",
      free,
      dup: false,
    });
  }

  // --- report -------------------------------------------------------------
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
      ` | portions eaten: ${sheet.length}` +
      ` in ${new Set(sheet.map((r) => `${r.date}|${canonical(r.name)}|${r.meal}`)).size} delivery rows`,
  );

  if (surcharges.length) {
    console.log(
      `\n${surcharges.length} credits under Rp 20.000 totalling Rp ${surcharges.reduce((s, c) => s + c.amount, 0).toLocaleString("id-ID")} read as ongkir top-ups — no order:`,
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

  if (unpriced.length) {
    console.log(
      `\n${unpriced.length} mapped credits have no package size — add them to backfill-2025-sizes.json:`,
    );
    for (const c of unpriced)
      console.log(
        `  ${c.date}  Rp ${String(c.amount).padStart(9)}  ${c.counterparty}  ${c.memo.slice(0, 60)}`,
      );
  }

  if (unmatched.length) {
    console.log(
      `\n${unmatched.length} credits totalling Rp ${unmatched.reduce((s, c) => s + c.amount, 0).toLocaleString("id-ID")} are not in the map — no order is written for these:`,
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
    for (const o of os ?? [])
      if (o.package_size)
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
  await write(db, plans, sheet);
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
    `\nWrote ${payload.length} delivery rows covering ${sheet.length} portions.`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  },
);
