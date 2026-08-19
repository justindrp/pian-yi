"use client";

import { ListFilter, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export type ColumnKind = "text" | "number" | "date";

export type FilterOp =
  | "contains"
  | "eq"
  | "gt"
  | "lt"
  | "between"
  | "before"
  | "after"
  | "is_empty"
  | "not_empty";

/**
 * One column's filter. `selected` is the Sheets-style value checklist —
 * undefined means "every value", which is not the same as an empty array
 * (that one matches nothing, and is what unticking everything gives you).
 * The condition (`op` + operands) is ANDed with the checklist.
 */
export type ColumnFilter = {
  selected?: string[];
  op?: FilterOp;
  a?: string;
  b?: string;
};

export const EMPTY_LABEL = "(kosong)";

export function isFilterActive(f: ColumnFilter | undefined): boolean {
  if (!f) return false;
  return f.selected !== undefined || f.op !== undefined;
}

/** Ops offered per column kind, in the order they appear in the popover. */
const OPS: Record<ColumnKind, { op: FilterOp; label: string }[]> = {
  text: [
    { op: "contains", label: "Berisi" },
    { op: "eq", label: "Sama dengan" },
    { op: "is_empty", label: "Kosong" },
    { op: "not_empty", label: "Tidak kosong" },
  ],
  number: [
    { op: "eq", label: "Sama dengan" },
    { op: "gt", label: "Lebih dari" },
    { op: "lt", label: "Kurang dari" },
    { op: "between", label: "Antara" },
    { op: "is_empty", label: "Kosong" },
  ],
  date: [
    { op: "after", label: "Setelah" },
    { op: "before", label: "Sebelum" },
    { op: "between", label: "Antara" },
    { op: "is_empty", label: "Kosong" },
  ],
};

function needsOperand(op: FilterOp): number {
  if (op === "is_empty" || op === "not_empty") return 0;
  if (op === "between") return 2;
  return 1;
}

/** Does one already-stringified cell value pass the condition half of a filter? */
export function passesCondition(
  raw: string | number | null,
  kind: ColumnKind,
  f: ColumnFilter,
): boolean {
  if (!f.op) return true;
  const empty = raw === null || raw === "";
  if (f.op === "is_empty") return empty;
  if (f.op === "not_empty") return !empty;
  if (empty) return false;

  if (kind === "number") {
    const n = Number(raw);
    const a = Number(f.a);
    if (Number.isNaN(n) || Number.isNaN(a)) return true;
    if (f.op === "eq") return n === a;
    if (f.op === "gt") return n > a;
    if (f.op === "lt") return n < a;
    if (f.op === "between") {
      const b = Number(f.b);
      return Number.isNaN(b) ? n >= a : n >= a && n <= b;
    }
    return true;
  }

  if (kind === "date") {
    // Cell values are ISO timestamps and operands are ISO dates, so a plain
    // string compare orders them correctly without parsing either.
    const v = String(raw).slice(0, 10);
    if (!f.a) return true;
    if (f.op === "after") return v >= f.a;
    if (f.op === "before") return v <= f.a;
    if (f.op === "between") return f.b ? v >= f.a && v <= f.b : v >= f.a;
    return true;
  }

  const v = String(raw).toLowerCase();
  const a = (f.a ?? "").toLowerCase();
  if (!a) return true;
  if (f.op === "eq") return v === a;
  if (f.op === "contains") return v.includes(a);
  return true;
}

type Props = {
  label: string;
  kind: ColumnKind;
  /**
   * Distinct values with counts, computed over the rows surviving every OTHER
   * column's filter — so picking an area never empties the state checklist.
   */
  options: { value: string; count: number }[];
  filter: ColumnFilter | undefined;
  sortDir: "asc" | "desc" | null;
  onSort: (dir: "asc" | "desc") => void;
  onChange: (next: ColumnFilter | undefined) => void;
};

export function ColumnFilterMenu({
  label,
  kind,
  options,
  filter,
  sortDir,
  onSort,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.value.toLowerCase().includes(needle));
  }, [options, q]);

  // undefined selected = everything ticked. Materialize it only when the admin
  // actually unticks something, so a filter stays absent from the URL until used.
  const selected = filter?.selected;
  const isTicked = (v: string) =>
    selected === undefined || selected.includes(v);
  const allShownTicked =
    shown.length > 0 && shown.every((o) => isTicked(o.value));

  function setSelected(next: string[] | undefined) {
    const merged: ColumnFilter = { ...filter, selected: next };
    onChange(isFilterActive(merged) ? merged : undefined);
  }

  function toggle(v: string) {
    const base = selected ?? options.map((o) => o.value);
    const next = base.includes(v) ? base.filter((x) => x !== v) : [...base, v];
    // Back to everything ticked is the same as no checklist at all.
    setSelected(next.length === options.length ? undefined : next);
  }

  function toggleAllShown() {
    const base = selected ?? options.map((o) => o.value);
    const shownValues = shown.map((o) => o.value);
    const next = allShownTicked
      ? base.filter((v) => !shownValues.includes(v))
      : [...new Set([...base, ...shownValues])];
    setSelected(next.length === options.length ? undefined : next);
  }

  function setOp(op: FilterOp | "") {
    if (!op) {
      const merged: ColumnFilter = { selected };
      onChange(isFilterActive(merged) ? merged : undefined);
      return;
    }
    onChange({ selected, op, a: filter?.a, b: filter?.b });
  }

  const active = isFilterActive(filter);
  const operands = filter?.op ? needsOperand(filter.op) : 0;
  const inputType =
    kind === "date" ? "date" : kind === "number" ? "number" : "text";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`ml-1 inline-flex items-center rounded p-0.5 align-middle hover:bg-gray-200 ${
            active ? "text-gray-900 bg-gray-200" : "text-gray-400"
          }`}
          aria-label={`Filter ${label}`}
        >
          <ListFilter className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0">
        <div className="border-b border-gray-100 p-1">
          <button
            type="button"
            onClick={() => {
              onSort("asc");
              setOpen(false);
            }}
            className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-gray-50 ${
              sortDir === "asc" ? "font-medium text-gray-900" : "text-gray-700"
            }`}
          >
            {kind === "text"
              ? "Urutkan A → Z"
              : kind === "date"
                ? "Terlama dulu"
                : "Terkecil dulu"}
          </button>
          <button
            type="button"
            onClick={() => {
              onSort("desc");
              setOpen(false);
            }}
            className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-gray-50 ${
              sortDir === "desc" ? "font-medium text-gray-900" : "text-gray-700"
            }`}
          >
            {kind === "text"
              ? "Urutkan Z → A"
              : kind === "date"
                ? "Terbaru dulu"
                : "Terbesar dulu"}
          </button>
        </div>

        <div className="space-y-2 border-b border-gray-100 p-2">
          <select
            value={filter?.op ?? ""}
            onChange={(e) => setOp(e.target.value as FilterOp | "")}
            className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
          >
            <option value="">Tanpa kondisi</option>
            {OPS[kind].map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
          {operands > 0 && (
            <div className="flex gap-2">
              <Input
                type={inputType}
                value={filter?.a ?? ""}
                onChange={(e) =>
                  onChange({ ...filter, op: filter?.op, a: e.target.value })
                }
                placeholder={operands === 2 ? "Dari" : "Nilai"}
                className="h-8 text-sm"
              />
              {operands === 2 && (
                <Input
                  type={inputType}
                  value={filter?.b ?? ""}
                  onChange={(e) =>
                    onChange({ ...filter, op: filter?.op, b: e.target.value })
                  }
                  placeholder="Sampai"
                  className="h-8 text-sm"
                />
              )}
            </div>
          )}
        </div>

        <div className="p-2">
          <div className="relative mb-2">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Cari nilai..."
              className="h-8 pl-7 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={toggleAllShown}
            className="mb-1 px-1 text-xs text-gray-500 hover:text-gray-900"
          >
            {allShownTicked ? "Hapus semua" : "Pilih semua"}
          </button>
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {shown.length === 0 && (
              <p className="px-1 py-2 text-xs text-gray-400">Tidak ada nilai</p>
            )}
            {shown.map((o) => (
              <label
                key={o.value}
                htmlFor={`f-${label}-${o.value}`}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-gray-50"
              >
                <Checkbox
                  id={`f-${label}-${o.value}`}
                  checked={isTicked(o.value)}
                  onCheckedChange={() => toggle(o.value)}
                />
                <span className="flex-1 truncate">{o.value}</span>
                <span className="text-xs text-gray-400">{o.count}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex justify-between border-t border-gray-100 p-2">
          <Button
            type="button"
            onClick={() => onChange(undefined)}
            className="h-8 rounded-lg bg-white text-sm text-gray-600 hover:bg-gray-50"
          >
            Hapus filter
          </Button>
          <Button
            type="button"
            onClick={() => setOpen(false)}
            className="h-8 rounded-lg bg-gray-900 text-sm text-white hover:bg-gray-800"
          >
            Selesai
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
