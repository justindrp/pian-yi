// Parses rows pasted from a spreadsheet into the free-quota grant table.
//
// The backfill this exists for is ~100 historical grants that live in a Google
// Sheet, and typing them one at a time is not a real option. Google Sheets and
// Excel both put tab-separated text on the clipboard, so that is the format
// this reads; comma-separated is accepted too, since OVERDRAW.md-style lists
// get hand-edited before pasting.
//
// Columns, in order: name, portions, date (optional), reason (optional).

export interface ParsedGrantRow {
  name: string;
  /** Absolute value — see parsePortions. Null when the cell wasn't a number. */
  portions: number | null;
  /** Y-m-d, or null when absent or unparseable. */
  date: string | null;
  reason: string;
}

function splitCells(line: string): string[] {
  // Tab wins when present: a reason like "kompensasi telat, minta maaf" contains
  // commas and must not be split on them.
  const cells = line.includes("\t") ? line.split("\t") : line.split(",");
  return cells.map((c) => c.trim());
}

/**
 * A grant is always a positive number of portions, so a negative cell is read
 * as the magnitude of a shortfall rather than rejected — OVERDRAW.md lists
 * balances as "-3", and that is the number of portions to grant. The UI says
 * so next to the paste box; it is not a silent correction.
 */
function parsePortions(cell: string): number | null {
  const cleaned = cell.replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.abs(Math.trunc(n));
}

function parseDate(cell: string): string | null {
  const t = cell.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // d/m/Y and d-m-Y, which is what a sheet formatted for Indonesia produces.
  const m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export function parseGrantPaste(text: string): ParsedGrantRow[] {
  return (
    text
      .split(/\r?\n/)
      // Not l.trim(): a row whose name cell is empty starts with a tab, and
      // trimming it would promote the portions cell to the name.
      .filter((l) => l.trim().length > 0)
      .map(splitCells)
      .filter((cells) => cells.some((c) => c.length > 0))
      .map((cells) => ({
        name: cells[0] ?? "",
        portions: parsePortions(cells[1] ?? ""),
        date: parseDate(cells[2] ?? ""),
        reason: (cells[3] ?? "").trim(),
      }))
      .filter((row) => row.name.length > 0)
  );
}

/**
 * Resolves a pasted name against the customer list.
 *
 * Returns null unless exactly one customer matches. Two customers share a name
 * often enough here that guessing would attach a grant to the wrong person's
 * ledger, and that is invisible once written — so an ambiguous name comes back
 * unmatched and the admin picks from the dropdown.
 */
export function matchCustomerByName<
  T extends { id: string; name: string | null; phone_number: string | null },
>(name: string, customers: T[]): T | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;

  const digits = q.replace(/\D/g, "");
  if (digits.length >= 8) {
    const byPhone = customers.filter((c) =>
      (c.phone_number ?? "").replace(/\D/g, "").endsWith(digits.slice(-9)),
    );
    if (byPhone.length === 1) return byPhone[0];
  }

  const exact = customers.filter(
    (c) => (c.name ?? "").trim().toLowerCase() === q,
  );
  if (exact.length === 1) return exact[0];
  return null;
}
