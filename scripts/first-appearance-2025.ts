/**
 * Writes FIRST_APPEARANCE_2025.md — the first date every name appears in the
 * Sep–Dec 2025 delivery sheet.
 *
 * Why: the package_orders sheet does not exist for that period, and the only
 * other record is the BCA transaction history, where the payer is often a
 * parent whose name never appears in the delivery sheet. A customer's first
 * delivery is the closest available proxy for when their package was bought —
 * a payment lands on or shortly before it.
 *
 *   set -a && . ./.env.local && set +a && pnpm tsx scripts/first-appearance-2025.ts
 */

import { writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

const SHEET_ID = "13cKpPcqdqXTpqWrWL5sDiZVNrYClzSBcrypO_CPZTgI";
const GID = "650194403";

type Row = {
  Tanggal: string;
  Nama: string;
  "Lunch/Dinner": string;
  Bayar: string;
  Free: string;
  Location: string;
};

/** MM/DD/YYYY → YYYY-MM-DD. The sheet is exported in US order. */
function parseDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/**
 * Confirmed typos, not different people — merged into the canonical spelling.
 * Only add a name here once someone has verified it; a wrong merge takes the
 * earlier first date and mis-dates the package.
 */
const NAME_ALIASES: Record<string, string> = {
  camdra: "candra",
  canrda: "candra",
};

/**
 * Groups "Verick", "verick ", "Verick 2" and "Verick (BSD)" together. The
 * trailing number is the sheet's own way of numbering a customer's repeat
 * packages, so it must not split them into separate people.
 */
function normalize(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\s+\d+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return NAME_ALIASES[base] ?? base;
}

/** Levenshtein distance — same helper shape as scripts/audit-sheet-data.ts. */
function lev(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

async function main() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const rows = parse(await res.text(), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as Row[];

  type Agg = {
    display: string;
    variants: Set<string>;
    first: string;
    last: string;
    deliveries: number;
    /** Rows on the first date — a package usually starts with one meal. */
    firstMeals: string[];
    paidRows: number;
    freeRows: number;
  };
  const byName = new Map<string, Agg>();
  let undated = 0;
  let unnamed = 0;

  for (const r of rows) {
    const name = (r.Nama ?? "").trim();
    const date = parseDate(r.Tanggal ?? "");
    if (!name) {
      if (date) unnamed++;
      continue;
    }
    if (!date) {
      undated++;
      continue;
    }
    const key = normalize(name);
    if (!key) continue;

    const agg = byName.get(key) ?? {
      display: name,
      variants: new Set<string>(),
      first: date,
      last: date,
      deliveries: 0,
      firstMeals: [],
      paidRows: 0,
      freeRows: 0,
    };
    agg.variants.add(name);
    agg.deliveries++;
    if ((r.Bayar ?? "").toUpperCase() === "TRUE") agg.paidRows++;
    if ((r.Free ?? "").toUpperCase() === "TRUE") agg.freeRows++;
    if (date < agg.first) {
      agg.first = date;
      agg.firstMeals = [];
    }
    if (date > agg.last) agg.last = date;
    if (date === agg.first)
      agg.firstMeals.push((r["Lunch/Dinner"] ?? "").trim());
    byName.set(key, agg);
  }

  const all = [...byName.values()].sort(
    (a, b) =>
      a.first.localeCompare(b.first) || a.display.localeCompare(b.display),
  );

  const dates = all.flatMap((a) => [a.first, a.last]).sort();
  const out: string[] = [];
  out.push("# First appearance — Sep–Dec 2025 delivery sheet");
  out.push("");
  out.push(
    `Generated ${new Date().toISOString().slice(0, 10)} by \`scripts/first-appearance-2025.ts\` from tab \`${GID}\`.`,
  );
  out.push("");
  out.push(
    `**${all.length} distinct customers, ${rows.length} sheet rows, deliveries from ${dates[0]} to ${dates[dates.length - 1]}.**`,
  );
  out.push("");
  out.push(
    "First delivery is a *proxy* for when the package was bought, not the purchase date. Payment lands on or shortly before it, so match a BCA credit to a name by looking at the days immediately preceding **First**.",
  );
  out.push("");
  out.push(
    "Names differing only by a trailing number, bracketed note, or case are folded together — the sheet numbers a customer's repeat packages that way. Verified typos are folded too, via `NAME_ALIASES` in the script (currently Camdra and Canrda → Candra). Every spelling seen is listed under Variants when there is more than one.",
  );
  out.push("");
  out.push(
    "| # | Name | First | First meal(s) | Last | Deliveries | Paid rows | Free rows | Variants |",
  );
  out.push("|---|---|---|---|---|---|---|---|---|");
  all.forEach((a, i) => {
    const variants =
      a.variants.size > 1 ? [...a.variants].sort().join(", ") : "";
    out.push(
      `| ${i + 1} | ${a.display} | ${a.first} | ${a.firstMeals.join(" + ")} | ${a.last} | ${a.deliveries} | ${a.paidRows} | ${a.freeRows} | ${variants} |`,
    );
  });
  out.push("");

  // Month-by-month arrivals: how many packages each month has to account for.
  const byMonth = new Map<string, string[]>();
  for (const a of all) {
    const m = a.first.slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), a.display]);
  }
  out.push("## New names per month");
  out.push("");
  out.push("| Month | New customers | Names |");
  out.push("|---|---|---|");
  for (const [m, names] of [...byMonth].sort()) {
    out.push(`| ${m} | ${names.length} | ${names.join(", ")} |`);
  }
  out.push("");

  // Near-duplicate names are suggested, never merged. "Kezia Wijaya" / "Kezia W"
  // is almost certainly one person, but "Jason" / "Jasmine" is not, and a wrong
  // merge would move somebody's first date and mis-date a package.
  const pairs: string[] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = normalize(all[i].display);
      const b = normalize(all[j].display);
      // Shared first name counts too: "Kezia Wijaya" / "Kezia W" is 5 edits
      // apart but one abbreviation of the other.
      const sameFirstToken = a.split(" ")[0] === b.split(" ")[0];
      const near =
        lev(a, b) <= 2 ||
        a.startsWith(`${b} `) ||
        b.startsWith(`${a} `) ||
        sameFirstToken;
      if (!near) continue;
      pairs.push(
        `| ${all[i].display} | ${all[i].first} | ${all[i].deliveries} | ${all[j].display} | ${all[j].first} | ${all[j].deliveries} |`,
      );
    }
  }
  if (pairs.length) {
    out.push("## Possible same person");
    out.push("");
    out.push(
      "Suggested by spelling distance only — **not** merged above. Check each before treating the pair as one customer; if they are one, the earlier **First** is the real one.",
    );
    out.push("");
    out.push("| Name A | First A | Deliv A | Name B | First B | Deliv B |");
    out.push("|---|---|---|---|---|---|");
    out.push(...pairs);
    out.push("");
  }

  if (undated || unnamed) {
    out.push("## Rows excluded");
    out.push("");
    if (undated)
      out.push(`- ${undated} rows have a name but no readable date.`);
    if (unnamed) out.push(`- ${unnamed} rows have a date but no name.`);
    out.push("");
  }

  writeFileSync("FIRST_APPEARANCE_2025.md", out.join("\n"));
  console.log(
    `FIRST_APPEARANCE_2025.md written: ${all.length} customers, ${rows.length} rows, ${dates[0]}..${dates[dates.length - 1]}`,
  );
  if (undated || unnamed)
    console.log(`excluded: ${undated} undated, ${unnamed} unnamed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
