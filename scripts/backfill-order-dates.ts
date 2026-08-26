/**
 * Backfill orders.created_at and orders.package_size from the package_orders
 * Google Sheet, which Justin has verified row by row up to 2026-07-11 and which
 * is the source of truth for that period.
 *
 * Two problems, one source:
 *
 *   created_at   — currently holds the date the June import script ran, not the
 *                  date the customer actually bought. The sheet's date + time
 *                  columns are the real purchase moment (Asia/Jakarta, +07:00).
 *
 *   package_size — 82 orders sit at 0, which is not a real package. Those were
 *                  excluded from the FIFO reconciliation because a zero-capacity
 *                  package makes the fill algorithm dump its deliveries onto a
 *                  neighbouring order, which is worse than leaving them alone.
 *
 * Matching is per customer, cheapest-signal-first: an exact (portion,
 * price_per_portion, total) triple, then (total, price_per_portion), then total
 * alone, and only then chronological position among whatever is left. Every
 * fallback used is printed, so a weak match is visible rather than silent.
 *
 * Dry run by default. --apply writes, and like reassign-draw-orders.ts it dumps
 * a complete rollback plan to disk before the first write.
 *
 *   pnpm tsx scripts/backfill-order-dates.ts
 *   pnpm tsx scripts/backfill-order-dates.ts --apply
 *   pnpm tsx scripts/backfill-order-dates.ts --rollback scripts/rollback-<ts>.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";

const SHEET_ID = "13cKpPcqdqXTpqWrWL5sDiZVNrYClzSBcrypO_CPZTgI";
const PKG_GID = "341974326";

// The sheet is verified through this date and no further. Rows after it are
// left alone — the app has been the source of truth since.
const VERIFIED_THROUGH = "2026-07-11";

const APPLY = process.argv.includes("--apply");
// Positional matches are a guess — they pair leftovers by chronological index
// once every value-based signal has failed. Three of the four found so far
// disagree with the sheet on package_size by a wide margin (db=152 vs sheet=5),
// which is what a wrong pairing looks like. Held back unless asked for.
const INCLUDE_WEAK = process.argv.includes("--include-weak");
const ROLLBACK_IDX = process.argv.indexOf("--rollback");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

// ── name matching (same rules as scripts/audit-sheet-data.ts) ───────────────

function parseName(name: string): { base: string; index: number } {
  const m = name.trim().match(/^(.+?)\s+(\d+)$/);
  if (m) return { base: m[1].trim(), index: Number.parseInt(m[2], 10) };
  return { base: name.trim(), index: 0 };
}

function nameKeys(name: string): string[] {
  const lower = name.trim().toLowerCase();
  const noParen = lower
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const base = parseName(noParen).base;
  return [...new Set([lower, noParen, base])].filter((k) => k.length > 0);
}

const NAME_ALIASES: Record<string, string> = {
  defi: "defi lugito",
  "febby bsd": "febby",
  "hanna bsd": "hanna",
  "steven gs": "steven",
  "vina bsd": "vina",
  "lani bsd": "lani diana",
  lani: "lani diana",
  nadita: "nadita putri",
  tio: "tio jason",
  diva: "diva felicia",
  dewita: "maria dewita",
  farrel: "farrell suryadi",
  katriel: "katriel scenny",
  "katriel m": "katriel scenny",
  aurellia: "aurellia hanzelita",
  "aurellia h": "aurellia hanzelita",
  frikri: "fikri",
  kressensia: "krissensia",
  nathaza: "nathaza caroline",
  "natalia s": "natalia saroso",
  melviina: "melvina",
  "zhoe bez": "zhoe",
  "zhoe allogio": "zhoe",
  "devi ipeka": "devi",
  "devi park serpong": "devi",
  rima: "rima/herlina",
};

function matchId(map: Map<string, string>, name: string): string | undefined {
  for (const k of nameKeys(name)) {
    const id = map.get(k);
    if (id) return id;
    const alias = NAME_ALIASES[k];
    if (alias) {
      const aliasId = map.get(alias);
      if (aliasId) return aliasId;
    }
  }
  return undefined;
}

function digits(s: string): number {
  return Number.parseInt((s ?? "").replace(/[^0-9]/g, ""), 10) || 0;
}

// ── sheet ───────────────────────────────────────────────────────────────────

type SheetRow = {
  line: number;
  name: string;
  date: string; // YYYY-MM-DD
  createdAt: string; // ISO with +07:00
  total: number;
  pricePerPortion: number;
  portion: number;
};

/** Sheet dates are M/D/YYYY; time is a bare HHMM string like "1944" or "0453". */
function toIso(
  dateRaw: string,
  timeRaw: string,
): { date: string; iso: string } | null {
  const m = dateRaw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const date = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  const t = (timeRaw ?? "").replace(/[^0-9]/g, "").padStart(4, "0");
  const hh = t.slice(0, 2);
  const mi = t.slice(2, 4);
  // Jakarta is UTC+7 year round, no DST, so a fixed offset is exact.
  return { date, iso: `${date}T${hh}:${mi}:00+07:00` };
}

async function fetchSheet(): Promise<SheetRow[]> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${PKG_GID}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sheet fetch failed: ${res.status}`);
  const raw = parse(await res.text(), {
    skip_empty_lines: false,
    relax_column_count: true,
    relax_quotes: true,
  }) as string[][];

  const rows: SheetRow[] = [];
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r) continue;
    const [checkbox, dateRaw, timeRaw, name, total, ppp, portion] = r;
    if (String(checkbox).trim().toUpperCase() !== "TRUE") continue;
    if (!name?.trim()) continue;
    const parsed = toIso(dateRaw ?? "", timeRaw ?? "");
    if (!parsed) continue;
    if (parsed.date > VERIFIED_THROUGH) continue;
    const p = digits(portion);
    if (p <= 0) continue;
    rows.push({
      line: i + 1,
      name: name.trim(),
      date: parsed.date,
      createdAt: parsed.iso,
      total: digits(total),
      pricePerPortion: digits(ppp),
      portion: p,
    });
  }
  return rows;
}

// ── db ──────────────────────────────────────────────────────────────────────

type Order = {
  id: string;
  customer_id: string | null;
  package_size: number | null;
  price_per_portion: number | null;
  total_price: number | null;
  created_at: string;
  start_date: string | null;
  status: string;
};

async function fetchAll<T>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from(table)
      .select(select)
      .range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const chunk = (data ?? []) as unknown as T[];
    out.push(...chunk);
    if (chunk.length < page) break;
  }
  return out;
}

// ── matching ────────────────────────────────────────────────────────────────

type Match = {
  order: Order;
  row: SheetRow;
  how: "triple" | "total+price" | "total" | "position";
};

/**
 * Match one customer's sheet rows to their DB orders. Strongest signal first so
 * a confident pairing is never stolen by a weaker one; whatever is left over is
 * paired by chronological position, which is a guess and is labelled as one.
 */
function matchCustomer(
  orders: Order[],
  rows: SheetRow[],
): {
  matches: Match[];
  unmatchedOrders: Order[];
  unmatchedRows: SheetRow[];
} {
  const freeOrders = [...orders];
  const freeRows = [...rows];
  const matches: Match[] = [];

  const take = (
    how: Match["how"],
    fits: (o: Order, r: SheetRow) => boolean,
  ) => {
    for (let ri = freeRows.length - 1; ri >= 0; ri--) {
      const r = freeRows[ri];
      const oi = freeOrders.findIndex((o) => fits(o, r));
      if (oi === -1) continue;
      matches.push({ order: freeOrders[oi], row: r, how });
      freeOrders.splice(oi, 1);
      freeRows.splice(ri, 1);
    }
  };

  take(
    "triple",
    (o, r) =>
      (o.package_size ?? 0) === r.portion &&
      (o.price_per_portion ?? 0) === r.pricePerPortion &&
      (o.total_price ?? 0) === r.total,
  );
  take(
    "total+price",
    (o, r) =>
      (o.total_price ?? 0) === r.total &&
      (o.price_per_portion ?? 0) === r.pricePerPortion,
  );
  take("total", (o, r) => (o.total_price ?? 0) === r.total && r.total > 0);

  // Positional fallback: only when the counts line up exactly. An uneven
  // leftover means the sheet and the DB genuinely disagree about how many
  // purchases this customer made, and pairing those by index would invent a
  // fact. Report instead.
  if (freeOrders.length > 0 && freeOrders.length === freeRows.length) {
    const os = [...freeOrders].sort((a, b) =>
      a.created_at < b.created_at ? -1 : 1,
    );
    const rs = [...freeRows].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : 1,
    );
    for (let i = 0; i < os.length; i++) {
      matches.push({ order: os[i], row: rs[i], how: "position" });
    }
    freeOrders.length = 0;
    freeRows.length = 0;
  }

  return { matches, unmatchedOrders: freeOrders, unmatchedRows: freeRows };
}

// ── rollback ────────────────────────────────────────────────────────────────

type RollbackPlan = {
  created_at: string;
  script: string;
  orders: {
    id: string;
    before: { created_at: string; package_size: number | null };
    after: { created_at: string; package_size: number | null };
  }[];
};

async function rollback(path: string): Promise<void> {
  const plan = JSON.parse(readFileSync(path, "utf8")) as RollbackPlan;
  let restored = 0;
  let changedSince = 0;

  for (const e of plan.orders) {
    const { data: cur } = await db
      .from("orders")
      .select("id, created_at, package_size")
      .eq("id", e.id)
      .maybeSingle();
    if (!cur) continue;

    // Only undo what this script did. If the row moved on since, leave it and
    // say so — silently stomping a later edit is worse than an incomplete undo.
    const patch: Record<string, unknown> = {};
    if (cur.created_at === e.after.created_at)
      patch.created_at = e.before.created_at;
    if (cur.package_size === e.after.package_size)
      patch.package_size = e.before.package_size;

    if (Object.keys(patch).length === 0) {
      changedSince++;
      console.log(`  changed since, skipped: ${e.id.slice(0, 8)}`);
      continue;
    }
    await db.from("orders").update(patch).eq("id", e.id);
    restored++;
  }
  console.log(
    `\nrolled back ${restored} orders, skipped ${changedSince} changed since.`,
  );
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (ROLLBACK_IDX !== -1) {
    const path = process.argv[ROLLBACK_IDX + 1];
    if (!path) throw new Error("--rollback needs a file path");
    await rollback(path);
    return;
  }

  const sheetRows = await fetchSheet();
  const orders = await fetchAll<Order>(
    "orders",
    "id, customer_id, package_size, price_per_portion, total_price, created_at, start_date, status",
  );
  const customers = await fetchAll<{ id: string; name: string | null }>(
    "customers",
    "id, name",
  );

  console.log(
    `sheet rows through ${VERIFIED_THROUGH}: ${sheetRows.length}, orders: ${orders.length}, customers: ${customers.length}`,
  );

  const nameToId = new Map<string, string>();
  for (const c of customers) {
    if (!c.name) continue;
    for (const k of nameKeys(c.name))
      if (!nameToId.has(k)) nameToId.set(k, c.id);
  }
  const idToName = new Map(customers.map((c) => [c.id, c.name ?? "(no name)"]));

  // group sheet rows by resolved customer id
  const rowsByCustomer = new Map<string, SheetRow[]>();
  const unresolvedNames: SheetRow[] = [];
  for (const r of sheetRows) {
    const cid = matchId(nameToId, r.name);
    if (!cid) {
      unresolvedNames.push(r);
      continue;
    }
    const list = rowsByCustomer.get(cid);
    if (list) list.push(r);
    else rowsByCustomer.set(cid, [r]);
  }

  const ordersByCustomer = new Map<string, Order[]>();
  for (const o of orders) {
    if (!o.customer_id) continue;
    const list = ordersByCustomer.get(o.customer_id);
    if (list) list.push(o);
    else ordersByCustomer.set(o.customer_id, [o]);
  }

  const dateChanges: {
    order: Order;
    row: SheetRow;
    how: Match["how"];
    name: string;
  }[] = [];
  const sizeFills: typeof dateChanges = [];
  const sizeConflicts: ((typeof dateChanges)[number] & { dbSize: number })[] =
    [];
  const weakMatches: typeof dateChanges = [];
  const leftoverOrders: { order: Order; name: string }[] = [];
  const leftoverRows: SheetRow[] = [];

  for (const [cid, rows] of rowsByCustomer) {
    const custOrders = ordersByCustomer.get(cid) ?? [];
    const name = idToName.get(cid) ?? "(unknown)";
    const { matches, unmatchedOrders, unmatchedRows } = matchCustomer(
      custOrders,
      rows,
    );

    for (const m of matches) {
      const entry = { order: m.order, row: m.row, how: m.how, name };
      const weak = m.how === "position" || m.how === "total";
      if (weak) {
        weakMatches.push(entry);
        if (!INCLUDE_WEAK) continue;
      }

      const dbSize = m.order.package_size ?? 0;
      if (dbSize === 0) sizeFills.push(entry);
      else if (dbSize !== m.row.portion)
        sizeConflicts.push({ ...entry, dbSize });

      if (m.order.created_at.slice(0, 10) !== m.row.date)
        dateChanges.push(entry);
    }
    for (const o of unmatchedOrders) leftoverOrders.push({ order: o, name });
    leftoverRows.push(...unmatchedRows);
  }

  const p = (s: string) => console.log(s);

  p(`\n=== created_at corrections (${dateChanges.length}) ===`);
  for (const c of dateChanges.slice(0, 40)) {
    p(
      `  ${c.name.padEnd(24)} ${c.order.id.slice(0, 8)}  ${c.order.created_at.slice(0, 10)} → ${c.row.createdAt.slice(0, 16)}  [${c.how}]`,
    );
  }
  if (dateChanges.length > 40) p(`  … ${dateChanges.length - 40} more`);

  p(`\n=== package_size 0 → real (${sizeFills.length}) ===`);
  for (const c of sizeFills) {
    p(
      `  ${c.name.padEnd(24)} ${c.order.id.slice(0, 8)}  0 → ${c.row.portion}  (total ${c.row.total}, ${c.how})`,
    );
  }

  p(`\n=== package_size disagrees, NOT changed (${sizeConflicts.length}) ===`);
  for (const c of sizeConflicts.slice(0, 30)) {
    p(
      `  ${c.name.padEnd(24)} ${c.order.id.slice(0, 8)}  db=${c.dbSize} sheet=${c.row.portion}  [${c.how}]`,
    );
  }
  if (sizeConflicts.length > 30) p(`  … ${sizeConflicts.length - 30} more`);

  p(`\n=== weak matches, review these (${weakMatches.length}) ===`);
  for (const c of weakMatches.slice(0, 30)) {
    p(
      `  ${c.name.padEnd(24)} ${c.order.id.slice(0, 8)}  sheet line ${c.row.line}  [${c.how}]`,
    );
  }
  if (weakMatches.length > 30) p(`  … ${weakMatches.length - 30} more`);

  p(`\n=== sheet rows with no matching order (${leftoverRows.length}) ===`);
  for (const r of leftoverRows.slice(0, 30)) {
    p(`  line ${r.line}  ${r.date} ${r.name} ${r.portion}p total ${r.total}`);
  }
  if (leftoverRows.length > 30) p(`  … ${leftoverRows.length - 30} more`);

  p(`\n=== orders with no matching sheet row (${leftoverOrders.length}) ===`);
  for (const o of leftoverOrders.slice(0, 30)) {
    p(
      `  ${o.name.padEnd(24)} ${o.order.id.slice(0, 8)}  ${o.order.created_at.slice(0, 10)} pkg=${o.order.package_size ?? 0} total=${o.order.total_price ?? 0} ${o.order.status}`,
    );
  }
  if (leftoverOrders.length > 30) p(`  … ${leftoverOrders.length - 30} more`);

  p(
    `\n=== sheet names not resolvable to a customer (${unresolvedNames.length}) ===`,
  );
  const badNames = [...new Set(unresolvedNames.map((r) => r.name))];
  for (const n of badNames.slice(0, 30)) p(`  ${n}`);
  if (badNames.length > 30) p(`  … ${badNames.length - 30} more`);

  const stillZero = orders.filter(
    (o) => (o.package_size ?? 0) === 0 && o.status === "active",
  ).length;
  p(
    `\nactive orders still at package_size 0 after this run: ${stillZero - sizeFills.filter((s) => s.order.status === "active").length}`,
  );

  if (!APPLY) {
    p("\nDRY RUN — nothing written. Re-run with --apply to write.");
    return;
  }

  // Build the whole rollback plan before touching a row, so an undo exists even
  // if the run dies halfway.
  const touched = new Map<
    string,
    { order: Order; created_at?: string; package_size?: number }
  >();
  for (const c of dateChanges) {
    const e = touched.get(c.order.id) ?? { order: c.order };
    e.created_at = c.row.createdAt;
    touched.set(c.order.id, e);
  }
  for (const c of sizeFills) {
    const e = touched.get(c.order.id) ?? { order: c.order };
    e.package_size = c.row.portion;
    touched.set(c.order.id, e);
  }

  const plan: RollbackPlan = {
    created_at: new Date().toISOString(),
    script: "backfill-order-dates.ts",
    orders: [...touched.values()].map((e) => ({
      id: e.order.id,
      before: {
        created_at: e.order.created_at,
        package_size: e.order.package_size,
      },
      after: {
        created_at: e.created_at ?? e.order.created_at,
        package_size: e.package_size ?? e.order.package_size,
      },
    })),
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rollbackPath = `scripts/rollback-${stamp}.json`;
  writeFileSync(rollbackPath, JSON.stringify(plan, null, 2));
  p(`rollback plan written: ${rollbackPath}`);

  let written = 0;
  for (const e of touched.values()) {
    const patch: Record<string, unknown> = {};
    if (e.created_at) patch.created_at = e.created_at;
    if (e.package_size != null) patch.package_size = e.package_size;
    const { error } = await db
      .from("orders")
      .update(patch)
      .eq("id", e.order.id);
    if (error) {
      p(`  FAILED ${e.order.id.slice(0, 8)}: ${error.message}`);
      continue;
    }
    written++;
  }

  p(`\nAPPLIED: ${written} orders updated.`);
  p(
    `Undo with: pnpm tsx scripts/backfill-order-dates.ts --rollback ${rollbackPath}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
