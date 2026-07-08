/**
 * Re-runnable data audit: scans package_orders and ORDER_HARIAN Google Sheets
 * against the CUSTOMERS Google Sheet (source of truth for names — NOT Supabase,
 * NOT the sheet's own Sisa Kuota column) and writes DATA_AUDIT.md listing every
 * missing field, blank name, name that does not match a CUSTOMERS row, and a
 * computed remaining quota per customer (purchased − delivered to date).
 *
 *   set -a && . ./.env.local && set +a && pnpm tsx scripts/audit-sheet-data.ts
 */

import { parse } from "csv-parse/sync";
import { writeFileSync } from "node:fs";

const SHEET_ID = "13cKpPcqdqXTpqWrWL5sDiZVNrYClzSBcrypO_CPZTgI";
const GID = { customers: "1454452383", harian: "1975392427", packages: "341974326" };

// ─── helpers (mirror import-customers-orders.ts) ────────────────────────────

function parseName(name: string): { base: string; index: number } {
  const m = name.trim().match(/^(.+?)\s+(\d+)$/);
  if (m) return { base: m[1].trim(), index: Number.parseInt(m[2], 10) };
  return { base: name.trim(), index: 0 };
}

function nameKeys(name: string): string[] {
  const lower = name.trim().toLowerCase();
  const noParen = lower.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
  const base = parseName(noParen).base;
  return [...new Set([lower, noParen, base])].filter((k) => k.length > 0);
}

const NAME_ALIASES: Record<string, string> = {
  defi: "defi lugito", "febby bsd": "febby", "hanna bsd": "hanna", "steven gs": "steven",
  "vina bsd": "vina", "lani bsd": "lani diana", lani: "lani diana", nadita: "nadita putri",
  tio: "tio jason", diva: "diva felicia", dewita: "maria dewita", farrel: "farrell suryadi",
  katriel: "katriel scenny", "katriel m": "katriel scenny", aurellia: "aurellia hanzelita",
  "aurellia h": "aurellia hanzelita", frikri: "fikri", kressensia: "krissensia",
  nathaza: "nathaza caroline", "natalia s": "natalia saroso", melviina: "melvina",
  "zhoe bez": "zhoe", "zhoe allogio": "zhoe", "devi ipeka": "devi", "devi park serpong": "devi",
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
  return Number.parseInt(s.replace(/[^0-9]/g, ""), 10) || 0;
}

function parseDate(raw: string): string | null {
  if (!raw || raw === "#N/A") return null;
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) return raw.slice(0, 10);
  return null;
}

// Levenshtein for "did you mean" suggestions.
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

function suggest(name: string, dbNames: string[]): string {
  const q = name.toLowerCase().replace(/\(.*?\)/g, "").trim();
  let best = "";
  let bestScore = Number.POSITIVE_INFINITY;
  for (const dn of dbNames) {
    const t = dn.toLowerCase();
    // strong signal: one is a prefix/substring of the other
    const contains = t.includes(q) || q.includes(t);
    const d = lev(q, t) - (contains ? 3 : 0);
    if (d < bestScore) { bestScore = d; best = dn; }
  }
  // only surface a suggestion if reasonably close
  return bestScore <= Math.max(2, Math.floor(q.length / 3)) ? best : "";
}

async function fetchCsv(gid: string): Promise<Record<string, string>[]> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${gid} failed: ${res.status}`);
  const raw = parse(await res.text(), {
    skip_empty_lines: false,
    relax_column_count: true,
    relax_quotes: true,
  }) as string[][];
  if (raw.length === 0) return [];
  // Primary table only: stop at first duplicate header.
  const headers = raw[0];
  const seen = new Set<string>();
  let colCount = headers.length;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim().toLowerCase();
    if (!h) continue;
    if (seen.has(h)) { colCount = i; break; }
    seen.add(h);
  }
  const cols = headers.slice(0, colCount);
  return raw.slice(1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => {
      const rec: Record<string, string> = {};
      for (let i = 0; i < colCount; i++) rec[cols[i].trim()] = (r[i] ?? "").trim();
      return rec;
    });
}

function col(row: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    for (const [h, v] of Object.entries(row)) {
      if (h.toLowerCase() === k.toLowerCase()) return v;
    }
  }
  // fallback: substring
  for (const k of keys) {
    for (const [h, v] of Object.entries(row)) {
      if (h.toLowerCase().includes(k.toLowerCase())) return v;
    }
  }
  return "";
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  const [custRows, pkgRows, harRows] = await Promise.all([
    fetchCsv(GID.customers),
    fetchCsv(GID.packages),
    fetchCsv(GID.harian),
  ]);

  // Source of truth for names: the CUSTOMERS sheet (not Supabase, not Sisa Kuota).
  const idByName = new Map<string, string>();
  const dbNames: string[] = [];
  for (const r of custRows) {
    const nama = col(r, ["nama", "name"]);
    if (!nama || nama === "#N/A") continue;
    dbNames.push(nama);
    for (const k of nameKeys(nama)) idByName.set(k, nama);
  }

  const out: string[] = [];
  const w = (s = "") => out.push(s);

  w("# Data Audit — package_orders / ORDER_HARIAN vs CUSTOMERS sheet");
  w("");
  w(`_Generated ${today}. Re-run: \`set -a && . ./.env.local && set +a && pnpm tsx scripts/audit-sheet-data.ts\`_`);
  w("");
  w(`CUSTOMERS sheet rows: **${dbNames.length}** · package_orders rows: **${pkgRows.length}** · ORDER_HARIAN rows: **${harRows.length}**`);
  w("");

  // ── A. package_orders: names with no match in the CUSTOMERS sheet ────────
  type Agg = { rows: number; porsi: number };
  const pkgUnmatched = new Map<string, Agg>();
  const pkgByCustomer = new Map<string, number>(); // canonical name -> total porsi purchased
  type Event = { date: string; porsi: number };
  const pkgEvents = new Map<string, Event[]>(); // canonical name -> dated purchase events
  let pkgFiller = 0;
  const pkgOrphan: string[] = []; // real purchase (date/porsi/total) but NO name
  const pkgBlankPorsi: string[] = [];
  const pkgSuspicious: string[] = [];
  for (const r of pkgRows) {
    const nama = col(r, ["nama", "name"]);
    const porsi = digits(col(r, ["porsi", "portions", "portion"]));
    const tgl = col(r, ["tanggal", "date"]);
    const total = digits(col(r, ["total harga", "total"]));
    if (!nama || nama === "#N/A") {
      // Distinguish a real purchase missing its name (has date/porsi/total) from
      // an empty template/filler row.
      if (parseDate(tgl) || porsi > 0 || total > 0) {
        pkgOrphan.push(`${tgl || "no date"} · ${porsi} porsi · Rp${total.toLocaleString("id-ID")}`);
      } else {
        pkgFiller++;
      }
      continue;
    }
    if (porsi === 0) pkgBlankPorsi.push(`${nama} (${tgl || "no date"})`);
    if (porsi > 500) pkgSuspicious.push(`${nama}: porsi=${porsi} (${col(r, ["tanggal", "date"])})`);
    const canonical = matchId(idByName, nama);
    if (!canonical) {
      const a = pkgUnmatched.get(nama) ?? { rows: 0, porsi: 0 };
      a.rows++; a.porsi += porsi;
      pkgUnmatched.set(nama, a);
    } else {
      pkgByCustomer.set(canonical, (pkgByCustomer.get(canonical) ?? 0) + porsi);
      const d = parseDate(tgl);
      if (d) {
        const evs = pkgEvents.get(canonical) ?? [];
        evs.push({ date: d, porsi });
        pkgEvents.set(canonical, evs);
      }
    }
  }

  w("## A. package_orders — names with NO matching customer in the CUSTOMERS sheet");
  w("");
  w("These purchases are not counted toward any customer's quota. Either the customer is missing from the CUSTOMERS sheet, or the name is spelled differently.");
  w("");
  if (pkgUnmatched.size === 0) {
    w("_None._");
  } else {
    w("| Sheet name | Rows | Σ Porsi | Likely DB match? |");
    w("|---|---|---|---|");
    for (const [name, a] of [...pkgUnmatched].sort((x, y) => y[1].porsi - x[1].porsi)) {
      const s = suggest(name, dbNames);
      w(`| ${name} | ${a.rows} | ${a.porsi} | ${s || "— (not in DB?)"} |`);
    }
  }
  w("");

  // ── A2. package_orders: real purchases missing a name ────────────────────
  w("## A2. package_orders — purchases with NO customer name (orphan purchases)");
  w("");
  w("Rows that record a date / portions / amount but have a blank Nama. Real money/quota that belongs to nobody — cannot be credited to any customer.");
  w("");
  if (pkgOrphan.length === 0) {
    w("_None._");
  } else {
    w(`**${pkgOrphan.length} orphan purchases:**`);
    w("");
    w("| Date | Detail |");
    w("|---|---|");
    for (const o of pkgOrphan) {
      const [date, ...rest] = o.split(" · ");
      w(`| ${date} | ${rest.join(" · ")} |`);
    }
  }
  w("");

  // ── B. ORDER_HARIAN: blank customer name ─────────────────────────────────
  const harBlankName: string[] = [];
  const harUnmatched = new Map<string, Agg>();
  const harByCustomer = new Map<string, number>(); // canonical name -> total porsi delivered to date
  const harEvents = new Map<string, Event[]>(); // canonical name -> dated delivery events (to date)
  const harBlankDate: number[] = [];
  const harZeroPorsi: string[] = [];
  const harNAarea: string[] = [];
  let harRowsScanned = 0;
  for (const r of harRows) {
    harRowsScanned++;
    const nama = col(r, ["nama", "customer"]);
    const tgl = col(r, ["tanggal", "date"]);
    const date = parseDate(tgl);
    const meal = col(r, ["lunch", "meal"]);
    const porsi = digits(col(r, ["jumlah", "porsi", "portions", "portion"]));
    const area = col(r, ["area"]);

    if (!nama || nama === "#N/A") {
      // Ignore empty template/filler rows (no date, no portions — just #N/A
      // formula cells dragged down the sheet). Only flag a blank name that
      // carries a real delivery (has a date or portions).
      if (date || porsi > 0) {
        harBlankName.push(`${tgl || "no date"} ${meal || "?"} — porsi ${porsi || "?"}`);
      }
      continue;
    }
    if (!date) harBlankDate.push(harRowsScanned);
    if (porsi === 0) harZeroPorsi.push(`${nama} ${tgl} ${meal}`);
    if (area === "#N/A" || area === "") harNAarea.push(`${nama} ${tgl}`);
    const canonical = matchId(idByName, nama);
    if (!canonical) {
      const a = harUnmatched.get(nama) ?? { rows: 0, porsi: 0 };
      a.rows++; a.porsi += porsi;
      harUnmatched.set(nama, a);
    } else if (!date || date <= today) {
      harByCustomer.set(canonical, (harByCustomer.get(canonical) ?? 0) + porsi);
      if (date) {
        const evs = harEvents.get(canonical) ?? [];
        evs.push({ date, porsi });
        harEvents.set(canonical, evs);
      }
    }
  }

  w("## B. ORDER_HARIAN — rows with BLANK / missing customer name");
  w("");
  w("Deliveries that name no customer. They deduct from nobody and cannot be reconciled.");
  w("");
  if (harBlankName.length === 0) {
    w("_None._");
  } else {
    w(`**${harBlankName.length} rows:**`);
    w("");
    for (const r of harBlankName) w(`- ${r}`);
  }
  w("");

  // ── C. ORDER_HARIAN: name no match in CUSTOMERS sheet ─────────────────────
  w("## C. ORDER_HARIAN — names with NO matching customer in the CUSTOMERS sheet");
  w("");
  w("These delivery rows are NOT deducted, so the named customer's remaining is overstated (or the customer is missing from the CUSTOMERS sheet).");
  w("");
  if (harUnmatched.size === 0) {
    w("_None._");
  } else {
    w("| Sheet name | Rows | Σ Porsi (delivered) | Likely match? |");
    w("|---|---|---|---|");
    for (const [name, a] of [...harUnmatched].sort((x, y) => y[1].porsi - x[1].porsi)) {
      const s = suggest(name, dbNames);
      w(`| ${name} | ${a.rows} | ${a.porsi} | ${s || "— (not in sheet?)"} |`);
    }
  }
  w("");

  // ── E. Computed remaining quota (package_orders − ORDER_HARIAN to date) ──
  w("## E. Computed remaining quota per customer (ignores Sisa Kuota column)");
  w("");
  w(`Remaining = Σ package_orders porsi − Σ ORDER_HARIAN porsi delivered on or before ${today}, matched by CUSTOMERS sheet name. Names from A/C (unmatched rows) are excluded — fix those first, they are not counted here.`);
  w("");
  const allCanonical = new Set([...pkgByCustomer.keys(), ...harByCustomer.keys()]);
  const remainingRows: { name: string; purchased: number; delivered: number; remaining: number }[] = [];
  for (const name of allCanonical) {
    const purchased = pkgByCustomer.get(name) ?? 0;
    const delivered = harByCustomer.get(name) ?? 0;
    remainingRows.push({ name, purchased, delivered, remaining: purchased - delivered });
  }
  remainingRows.sort((a, b) => a.remaining - b.remaining);
  const negative = remainingRows.filter((r) => r.remaining < 0);
  // Customers with 0 logged purchases but deliveries: package_orders was only
  // backfilled from Dec 1 onward, so these are a data-gap, not a real deficit.
  const noHistory = negative.filter((r) => r.purchased === 0);
  const realDeficit = negative.filter((r) => r.purchased > 0);
  w(`**${realDeficit.length} customer(s) with negative computed remaining despite having logged purchases** (candidates for free/goodwill quota — see Section F):`);
  w("");
  if (realDeficit.length === 0) {
    w("_None._");
  } else {
    w("| Customer | Purchased | Delivered | Remaining |");
    w("|---|---|---|---|");
    for (const r of realDeficit) w(`| ${r.name} | ${r.purchased} | ${r.delivered} | ${r.remaining} |`);
  }
  w("");
  w(`**${noHistory.length} customer(s) with 0 logged purchases but deliveries exist** — package_orders was only backfilled from Dec 1, 2025 onward; these predate the backfill and are not a real deficit:`);
  w("");
  if (noHistory.length === 0) {
    w("_None._");
  } else {
    for (const r of noHistory) w(`- ${r.name} (delivered ${r.delivered})`);
  }
  w("");
  w("<details><summary>Full computed remaining quota, all customers</summary>");
  w("");
  w("| Customer | Purchased | Delivered | Remaining |");
  w("|---|---|---|---|");
  for (const r of [...remainingRows].sort((a, b) => a.name.localeCompare(b.name))) {
    w(`| ${r.name} | ${r.purchased} | ${r.delivered} | ${r.remaining} |`);
  }
  w("");
  w("</details>");
  w("");

  // ── F. Free-quota check: dates where a customer's running balance goes negative ──
  w("## F. Free quota check — dates a customer's balance went negative");
  w("");
  w("For each customer with a real deficit (has purchases, still over-delivered — Section E), walks purchase and delivery events in date order and flags each delivery date where the running balance drops below zero. Use this to find *when* a free/goodwill portion (e.g. late-delivery compensation) was likely given, so it can be logged. `Gaylen (Influencer)` is excluded — permanent 1-portion/month barter for endorsement content, not a data issue.");
  w("");
  const KNOWN_EXCEPTIONS = ["gaylen"];
  const deficitNames = realDeficit
    .map((r) => r.name)
    .filter((n) => !KNOWN_EXCEPTIONS.some((k) => n.toLowerCase().includes(k)));
  if (deficitNames.length === 0) {
    w("_None._");
  } else {
    for (const name of deficitNames) {
      const timeline = [
        ...(pkgEvents.get(name) ?? []).map((e) => ({ ...e, kind: "purchase" as const })),
        ...(harEvents.get(name) ?? []).map((e) => ({ ...e, kind: "delivery" as const })),
      ].sort((a, b) => a.date.localeCompare(b.date));
      let balance = 0;
      const flags: string[] = [];
      for (const ev of timeline) {
        const before = balance;
        balance += ev.kind === "purchase" ? ev.porsi : -ev.porsi;
        // Only flag the day balance first crosses from >=0 into negative —
        // that's the likely free/goodwill grant. Later deliveries while still
        // negative are just spending down that same grant, not a new one.
        if (ev.kind === "delivery" && before >= 0 && balance < 0) {
          flags.push(`${ev.date} (balance goes ${before} → ${balance})`);
        }
      }
      w(`**${name}** — total deficit ${remainingRows.find((r) => r.name === name)?.remaining ?? "?"}, ${flags.length} likely grant date(s):`);
      if (flags.length === 0) {
        w("- (deficit only from unmatched/unlogged purchases before Dec 1 — no specific over-delivery date found)");
      } else {
        for (const f of flags) w(`- ${f}`);
      }
      w("");
    }
  }

  // ── D. other missing/suspect fields ──────────────────────────────────────
  w("## D. Other missing / suspicious data");
  w("");
  w("### package_orders");
  w(`- Real purchases missing a name (orphans, see A2): **${pkgOrphan.length}**`);
  w(`- Empty template/filler rows (ignored): **${pkgFiller}**`);
  w(`- Named rows with Porsi = 0: **${pkgBlankPorsi.length}**${pkgBlankPorsi.length ? ` — ${pkgBlankPorsi.join("; ")}` : ""}`);
  w(`- Suspicious Porsi > 500 (likely typo): **${pkgSuspicious.length}**${pkgSuspicious.length ? ` — ${pkgSuspicious.join("; ")}` : ""}`);
  w("");
  w("### ORDER_HARIAN");
  w(`- Rows with unparseable date: **${harBlankDate.length}**`);
  w(`- Rows with Porsi = 0: **${harZeroPorsi.length}**${harZeroPorsi.length ? ` — ${harZeroPorsi.slice(0, 40).join("; ")}${harZeroPorsi.length > 40 ? " …" : ""}` : ""}`);
  w(`- Rows with blank / #N/A area: **${harNAarea.length}**`);
  w("");

  w("## How to fix");
  w("");
  w("1. **Section A/C suggestions**: if \"Likely match\" is right, rename the sheet entry to match the CUSTOMERS sheet exactly (or add an alias in `scripts/import-customers-orders.ts` → `NAME_ALIASES`).");
  w("2. **\"not in sheet?\"**: the customer is missing from CUSTOMERS — add them there, or confirm they are non-customers (e.g. `panti`, `tambahan acara`).");
  w("3. **Section A2 orphan purchases**: fill the Nama column in package_orders so the quota credits a customer.");
  w("4. **Section D zeros/typos**: correct the Porsi cells.");
  w("5. **Section E**: negative remaining means over-delivered vs purchases, or a purchase row is still unmatched (fix A first) — this replaces the Sisa Kuota column as the trusted number.");
  w("6. Re-run this audit, then `--reconcile --dry-run` to confirm the numbers settle.");

  writeFileSync("DATA_AUDIT.md", `${out.join("\n")}\n`);
  console.log("Wrote DATA_AUDIT.md");
  console.log(`  package unmatched: ${pkgUnmatched.size}, harian blank-name: ${harBlankName.length}, harian unmatched: ${harUnmatched.size}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
