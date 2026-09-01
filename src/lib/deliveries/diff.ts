import { isDeliveryDay } from "@/lib/holidays/id";

/**
 * The last day we cooked before `ymd`. Minggu and libur nasional are skipped,
 * because comparing Senin against Minggu says everybody stopped eating.
 */
export function previousDeliveryDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  for (let i = 0; i < 14; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const candidate = d.toISOString().slice(0, 10);
    if (isDeliveryDay(candidate)) return candidate;
  }
  return d.toISOString().slice(0, 10);
}

export interface DiffRow {
  customer_id: string;
  meal_type: string;
  portions: number;
  customers?: { name: string | null } | null;
}

export interface DiffEntry {
  customerId: string;
  name: string;
  mealType: string;
  /** Portions on the earlier day; 0 when the row is new. */
  before: number;
  /** Portions on the selected day; 0 when the row is gone. */
  after: number;
}

export interface SheetDiff {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  beforePortions: number;
  afterPortions: number;
  beforeRows: number;
  afterRows: number;
}

const key = (r: DiffRow) => `${r.customer_id}:${r.meal_type}`;

/**
 * What moved between two days' sheets, per customer per meal.
 *
 * Keyed on customer + meal rather than on the row id: a customer who skips a
 * date and books it again gets a new row id for the same meal, and reading
 * that as one person leaving and another arriving is the opposite of the
 * answer. Portions are summed per key, because a customer can hold two orders
 * and draw a row from each on the same meal.
 */
export function diffSheets(before: DiffRow[], after: DiffRow[]): SheetDiff {
  const fold = (rows: DiffRow[]) => {
    const m = new Map<string, DiffEntry & { portions: number }>();
    for (const r of rows) {
      const k = key(r);
      const existing = m.get(k);
      if (existing) {
        existing.portions += r.portions;
        continue;
      }
      m.set(k, {
        customerId: r.customer_id,
        name: r.customers?.name ?? "(tanpa nama)",
        mealType: r.meal_type,
        before: 0,
        after: 0,
        portions: r.portions,
      });
    }
    return m;
  };

  const b = fold(before);
  const a = fold(after);

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffEntry[] = [];

  for (const [k, entry] of a) {
    const prev = b.get(k);
    if (!prev) {
      added.push({ ...entry, before: 0, after: entry.portions });
    } else if (prev.portions !== entry.portions) {
      changed.push({ ...entry, before: prev.portions, after: entry.portions });
    }
  }
  for (const [k, entry] of b) {
    if (!a.has(k))
      removed.push({ ...entry, before: entry.portions, after: 0 });
  }

  const sum = (rows: DiffRow[]) => rows.reduce((t, r) => t + r.portions, 0);
  const byName = (x: DiffEntry, y: DiffEntry) => x.name.localeCompare(y.name);

  return {
    added: added.sort(byName),
    removed: removed.sort(byName),
    changed: changed.sort(byName),
    beforePortions: sum(before),
    afterPortions: sum(after),
    beforeRows: before.length,
    afterRows: after.length,
  };
}
