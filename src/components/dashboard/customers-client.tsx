"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns3 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ColumnFilter,
  ColumnFilterMenu,
  type ColumnKind,
  EMPTY_LABEL,
  type FilterOp,
  isFilterActive,
  passesCondition,
} from "@/components/dashboard/column-filter";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useDeliveryAreas, withCurrentAreas } from "@/hooks/use-delivery-areas";
import {
  deriveCustomerDisplayState,
  hasCurrentOrder,
} from "@/lib/customers/lifecycle";
import {
  type DrawCandidate,
  pickDrawOrder,
} from "@/lib/orders/pick-draw-order";
import { matchCustomerByName, parseGrantPaste } from "@/lib/grants/parse-paste";
import { createClient } from "@/lib/supabase/client";
import { jakartaDateString } from "@/lib/menu/week";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { formatDate, maskPhone } from "@/lib/utils/format";
import type { Database } from "@/types/database";

type Customer = Database["public"]["Tables"]["customers"]["Row"];
type CustomerState = Database["public"]["Tables"]["customer_state"]["Row"];
type CustomerFlags = Database["public"]["Tables"]["customer_flags"]["Row"];
type Order = Database["public"]["Tables"]["orders"]["Row"];
type CustomerListRow = Customer & {
  customer_state: CustomerState | null;
  customer_flags: CustomerFlags | null;
  display_state: string;
  // Derived from the customer's open orders, not read from the cached
  // customers.portions_remaining / avg_price_per_portion columns. Those are the
  // unfinished half of migration 035 (a WAC model that was never completed):
  // six code paths write them, one cell read them, and nothing kept them in
  // sync — 65 of 333 customers had a wrong balance and 127 a wrong avg price,
  // including one showing Rp 32.333, above any tier that has ever existed.
  // Deriving here makes this page agree with Orders and the customer ledger.
  derived_remaining: number;
  // What the next portion this customer draws will cost, not a blend of what
  // they hold. pickDrawOrder() drains the oldest active order with undated
  // portions left, and each order locked its price at creation, so that order's
  // price_per_portion is the only rate any of their food is billed at. The
  // weighted average this replaced was migration 035's WAC formula computed on
  // read: galvent showed Rp 28.385 across a 29.000 order and a 28.000 order,
  // a rate nothing has ever charged and nothing ever will.
  derived_next_price: number;
  kitchen: string | null;
};

type LedgerRow = {
  id: string;
  kind: "package" | "draw";
  date: string;
  label: string;
  meal_type: string | null;
  change: number;
  status: string | null;
  scheduled: boolean;
  balance: number;
};
type LedgerData = {
  rows: LedgerRow[];
  totalPackage: number;
  totalDrawn: number;
  balance: number;
  balanceToday: number;
};

// One line of the free-quota batch table. customer_id is "" until a customer is
// picked (or a pasted name is matched), which is what marks a row incomplete —
// customer_name doubles as the combobox's search text so a pasted name stays
// visible while the admin resolves it.
type GrantRow = {
  key: string;
  customer_id: string;
  customer_name: string;
  portions: number | null;
  date: string;
  reason: string;
};

function grantRowValid(r: GrantRow): boolean {
  return (
    r.customer_id !== "" &&
    r.portions !== null &&
    r.portions > 0 &&
    r.reason.trim() !== ""
  );
}

// Offered in the reason dropdown. Grounded in the six reasons already in the
// database plus the backfill this table was built for. The field stays free
// text — these are shortcuts, not an allowlist, because a one-off reason like
// "Harusnya tanpa sapi, tapi yang dikirim sapi" must still be writable.
const GRANT_REASONS = [
  "Backfill kuota historis",
  "Kompensasi keterlambatan",
  "Menu tidak sesuai pesanan",
  "Kuota terpotong salah",
  "Promo reaktivasi",
  "Barter influencer",
];

let grantRowSeq = 0;
function newGrantRow(date: string, reason = ""): GrantRow {
  grantRowSeq += 1;
  return {
    key: `g${grantRowSeq}`,
    customer_id: "",
    customer_name: "",
    portions: null,
    date,
    reason,
  };
}

const PAGE_SIZE = 200;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
// Every column the table can show, in display order. One definition drives the
// header, the filter popover, the sort comparator and the cell — so a column
// can never be sortable but unfilterable, or shown with no way to filter it.
// `value` is what filtering and sorting see; the cell may render it differently.
type ColumnDef = {
  key: string;
  label: string;
  kind: ColumnKind;
  value: (r: CustomerListRow) => string | number | null;
  defaultVisible: boolean;
  align?: "right";
  /** Hidden below the sm breakpoint, matching the old table's behaviour. */
  smOnly?: boolean;
};

const COLUMNS: ColumnDef[] = [
  {
    key: "customer_number",
    label: "#",
    kind: "number",
    value: (r) => r.customer_number,
    defaultVisible: true,
  },
  {
    key: "name",
    label: "Name",
    kind: "text",
    value: (r) => r.name,
    defaultVisible: true,
  },
  {
    key: "phone_number",
    label: "Phone",
    kind: "text",
    value: (r) => r.phone_number,
    defaultVisible: true,
  },
  {
    key: "area",
    label: "Area",
    kind: "text",
    value: (r) => r.area,
    defaultVisible: true,
  },
  {
    key: "sub_area",
    label: "Sub Area",
    kind: "text",
    value: (r) => r.sub_area,
    defaultVisible: true,
    smOnly: true,
  },
  {
    key: "derived_remaining",
    label: "Remaining",
    kind: "number",
    value: (r) => r.derived_remaining,
    defaultVisible: true,
    align: "right",
    smOnly: true,
  },
  {
    key: "derived_next_price",
    label: "Next Price",
    kind: "number",
    value: (r) => r.derived_next_price,
    defaultVisible: true,
    align: "right",
    smOnly: true,
  },
  {
    key: "display_state",
    label: "State",
    kind: "text",
    value: (r) => r.display_state,
    defaultVisible: true,
  },
  {
    key: "created_at",
    label: "Joined",
    kind: "date",
    value: (r) => r.created_at,
    defaultVisible: true,
    smOnly: true,
  },
  {
    key: "kitchen",
    label: "Kitchen",
    kind: "text",
    value: (r) => r.kitchen,
    defaultVisible: false,
  },
  {
    key: "contract_price_per_portion",
    label: "Contract price",
    kind: "number",
    value: (r) => r.contract_price_per_portion,
    defaultVisible: false,
    align: "right",
  },
  {
    key: "address_type",
    label: "Address type",
    kind: "text",
    value: (r) => r.address_type,
    defaultVisible: false,
  },
  {
    key: "meal_time_preference",
    label: "Meal pref",
    kind: "text",
    value: (r) => r.meal_time_preference,
    defaultVisible: false,
  },
  {
    key: "delivery_route",
    label: "Route",
    kind: "number",
    value: (r) => r.delivery_route,
    defaultVisible: false,
  },
  {
    key: "ad_creative",
    label: "Ad creative",
    kind: "text",
    value: (r) => r.ad_creative,
    defaultVisible: false,
  },
  {
    key: "promo_used",
    label: "Promo",
    kind: "text",
    value: (r) => r.promo_used,
    defaultVisible: false,
  },
  {
    key: "converted_to_subscription",
    label: "Subscribed",
    kind: "text",
    value: (r) => (r.converted_to_subscription ? "Ya" : "Tidak"),
    defaultVisible: false,
  },
  {
    key: "linked",
    label: "Linked",
    kind: "text",
    value: (r) => (r.linked_order_id ? "Ya" : "Tidak"),
    defaultVisible: false,
  },
  {
    key: "notes",
    label: "Notes",
    kind: "text",
    value: (r) => r.notes,
    defaultVisible: false,
  },
];

// Per-column text colour, matching what the hand-written cells used before the
// table became column-driven. Anything unlisted falls back to text-gray-500.
const CELL_TONE: Record<string, string> = {
  customer_number: "text-gray-400 text-xs tabular-nums",
  name: "text-gray-900",
  derived_remaining: "text-gray-700",
  derived_next_price: "text-gray-500 text-xs",
  created_at: "text-gray-400 text-xs",
  notes: "text-gray-400 text-xs",
};

const DEFAULT_COLS = COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);
const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

/** The value a filter checklist matches on. Empty cells get their own entry. */
function cellLabel(col: ColumnDef, r: CustomerListRow): string {
  const v = col.value(r);
  if (v === null || v === "") return EMPTY_LABEL;
  if (col.kind === "date") return formatDate(String(v));
  if (col.kind === "number" && v === 0) return "0";
  return String(v);
}

function passesFilter(
  col: ColumnDef,
  r: CustomerListRow,
  f: ColumnFilter,
): boolean {
  if (f.selected && !f.selected.includes(cellLabel(col, r))) return false;
  return passesCondition(col.value(r), col.kind, f);
}

// ?f=area:in:BSD Baru~Alam Sutera;derived_remaining:gt:0
// Values are separated by ~ because an area name can contain a comma and a
// state cannot contain a tilde; the whole parameter is URI-encoded anyway.
function serializeFilters(filters: Record<string, ColumnFilter>): string {
  const parts: string[] = [];
  for (const [key, f] of Object.entries(filters)) {
    if (!isFilterActive(f)) continue;
    if (f.selected) parts.push(`${key}:in:${f.selected.join("~")}`);
    if (f.op) {
      parts.push(`${key}:${f.op}:${f.a ?? ""}${f.b ? `~${f.b}` : ""}`);
    }
  }
  return parts.join(";");
}

function parseFilters(raw: string | null): Record<string, ColumnFilter> {
  if (!raw) return {};
  const out: Record<string, ColumnFilter> = {};
  for (const part of raw.split(";")) {
    const [key, op, rest] = part.split(":");
    if (!key || !op || !COLUMN_BY_KEY.has(key)) continue;
    const existing = out[key] ?? {};
    if (op === "in") {
      existing.selected = (rest ?? "").split("~").filter(Boolean);
    } else {
      const [a, b] = (rest ?? "").split("~");
      existing.op = op as FilterOp;
      existing.a = a || undefined;
      existing.b = b || undefined;
    }
    out[key] = existing;
  }
  return out;
}

export default function CustomersClient() {
  // Filters, sort, page and visible columns all live in the URL, so a filtered
  // view is a link an admin can send to Annie rather than a list of clicks.
  const router = useRouter();
  const params = useSearchParams();
  const sortKey = params.get("sort") ?? "customer_number";
  const sortDir = (params.get("dir") === "desc" ? "desc" : "asc") as
    | "asc"
    | "desc";
  const page = Math.max(0, Number(params.get("page") ?? 0) || 0);
  const filters = useMemo(() => parseFilters(params.get("f")), [params]);
  const visibleCols = useMemo(() => {
    const raw = params.get("cols");
    const keys = raw
      ? raw.split(",").filter((k) => COLUMN_BY_KEY.has(k))
      : DEFAULT_COLS;
    // Keep declaration order however the parameter was written.
    return COLUMNS.filter((c) => keys.includes(c.key));
  }, [params]);

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      // Filtering is not navigation — replace so the back button leaves the
      // page rather than stepping back through every checkbox.
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  const [search, setSearch] = useState(() => params.get("q") ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(
    () => params.get("q") ?? "",
  );
  const [selected, setSelected] = useState<Customer | null>(null);
  const [editingCell, setEditingCell] = useState<{
    id: string;
    field: "name" | "area" | "sub_area";
    value: string;
  } | null>(null);
  // Areas come from the active subcontractors, never from a list in this file.
  const deliveryAreas = useDeliveryAreas();
  const [editForm, setEditForm] = useState({
    phone_number: "",
    name: "",
    address: "",
    area: "",
    sub_area: "",
    subcontractor_id: "",
    address_type: "",
    delivery_phone: "",
    google_maps_link: "",
    meal_time_preference: "",
    ad_creative: "",
    promo_used: "",
    converted_to_subscription: false,
    notes: "",
    address_2: "",
    area_2: "",
    sub_area_2: "",
    google_maps_link_2: "",
    linked_order_id: "",
    contract_price_per_portion: "",
  });
  const [showAdd, setShowAdd] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [showDeliveryModal, setShowDeliveryModal] = useState(false);
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth());
  const [deliveryPortions, setDeliveryPortions] = useState<
    Record<string, { lunch: number; dinner: number }>
  >({});
  const [showGrant, setShowGrant] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [grantRows, setGrantRows] = useState<GrantRow[]>([]);
  // Which row's customer dropdown is open — one at a time, by row key.
  const [grantOpenRow, setGrantOpenRow] = useState<string | null>(null);
  const [grantPaste, setGrantPaste] = useState("");
  const [showGrantPaste, setShowGrantPaste] = useState(false);
  const [grantBulkDate, setGrantBulkDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [grantBulkReason, setGrantBulkReason] = useState("");
  const [addForm, setAddForm] = useState({
    name: "",
    phone_number: "",
    area: "",
    sub_area: "",
    address: "",
    address_2: "",
    google_maps_link: "",
    subcontractor_id: "",
    linked_order_id: "",
  });
  const queryClient = useQueryClient();
  const supabase = createClient();

  const { data: subcontractors } = useQuery({
    queryKey: ["subcontractors"],
    queryFn: async () => {
      const res = await fetch("/api/subcontractors");
      const json = (await res.json()) as {
        ok: boolean;
        data: Array<{ id: string; name: string; is_active: boolean }>;
      };
      return (json.data ?? []).filter((s) => s.is_active);
    },
  });

  const { data: linkableCustomers } = useQuery({
    queryKey: ["customers-linkable"],
    queryFn: async () => {
      const res = await fetch("/api/customers?all=true");
      const json = (await res.json()) as {
        ok: boolean;
        data: Array<{
          id: string;
          name: string | null;
          active_order_id: string | null;
        }>;
      };
      return (json.data ?? []).filter((c) => c.active_order_id);
    },
  });

  const { data: allCustomers } = useQuery({
    queryKey: ["customers-all"],
    enabled: showGrant,
    queryFn: async () => {
      const res = await fetch("/api/customers?all=true");
      const json = (await res.json()) as {
        ok: boolean;
        data: Array<{
          id: string;
          name: string | null;
          phone_number: string | null;
        }>;
      };
      return json.data ?? [];
    },
  });

  const { data: ledger, isLoading: ledgerLoading } = useQuery({
    queryKey: ["customer-ledger", selected?.id],
    enabled: !!selected,
    queryFn: async () => {
      const res = await fetch(`/api/customers/${selected?.id}`);
      const json = (await res.json()) as { ok: boolean; data: LedgerData };
      return json.data;
    },
  });

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setParams({ q: search || null, page: null });
    }, 300);
    return () => clearTimeout(t);
  }, [search, setParams]);

  // The whole list, not a page of it. Remaining, Avg Price and State are
  // computed here from the customer's orders — they are not columns Postgres
  // holds, so sorting or filtering on them over a 200-row window would rank the
  // first 200 and silently call it the answer. Architectural principle 9.
  const { data, isLoading } = useQuery({
    queryKey: ["customers-list"],
    queryFn: async () => {
      // WIB, not UTC. Railway runs UTC, so between 00:00 and 07:00 WIB
      // `toISOString()` names yesterday and every delivery dated today drops
      // out of the balance.
      const today = jakartaDateString();
      const [customerPages, orderPages, deliveryPages] = await Promise.all([
        fetchAllRows<
          Customer & {
            customer_state: CustomerState | null;
            customer_flags: CustomerFlags | null;
          }
        >(
          (from, to) =>
            supabase
              .from("customers")
              .select("*, customer_state(*), customer_flags(*)")
              .order("customer_number", { ascending: true, nullsFirst: false })
              .order("created_at", { ascending: false })
              .range(from, to) as never,
        ),
        fetchAllRows<
          Pick<
            Order,
            | "id"
            | "customer_id"
            | "status"
            | "created_at"
            | "start_date"
            | "package_size"
            | "price_per_portion"
          >
        >((from, to) =>
          supabase
            .from("orders")
            .select(
              "id, customer_id, status, created_at, start_date, package_size, price_per_portion",
            )
            .order("created_at", { ascending: false })
            .range(from, to),
        ),
        // The whole calendar, split at today by the caller below. There is no
        // stored balance to read instead — the dropped orders.portions_remaining
        // counted bookings, so a customer whose package was fully dated read 0
        // with every meal still to come. Both halves are needed and they are
        // different numbers: rows up to today are what an order has drawn (the
        // balance), every row is what it has booked (what pickDrawOrder calls
        // unbooked, and what decides which order the next portion bills to).
        fetchAllRows<{
          order_id: string | null;
          customer_id: string | null;
          delivery_date: string;
          portions: number | null;
        }>((from, to) =>
          supabase
            .from("daily_deliveries")
            .select("order_id, customer_id, delivery_date, portions")
            .range(from, to),
        ),
      ]);
      if (customerPages.error) throw new Error(customerPages.error);
      if (orderPages.error) throw new Error(orderPages.error);
      if (deliveryPages.error) throw new Error(deliveryPages.error);

      const customers = customerPages.rows;
      const orders = orderPages.rows;

      // Drawn is counted per customer and booked per order, and that asymmetry
      // is the point. What a customer has left does not depend on which of
      // their orders a row was charged to; which order the *next* row bills to
      // does. Counting the balance per order made it depend on attribution, and
      // the attribution is not sound — see the netting note below.
      const drawnByCustomer = new Map<string, number>();
      const bookedByOrder = new Map<string, number>();
      for (const row of deliveryPages.rows) {
        const portions = row.portions ?? 0;
        if (row.order_id) {
          bookedByOrder.set(
            row.order_id,
            (bookedByOrder.get(row.order_id) ?? 0) + portions,
          );
        }
        if (row.customer_id && row.delivery_date <= today) {
          drawnByCustomer.set(
            row.customer_id,
            (drawnByCustomer.get(row.customer_id) ?? 0) + portions,
          );
        }
      }

      // Everything the customer bought, against everything they have eaten —
      // the same two sums the ledger drawer shows as `balanceToday`, so the
      // list and the drawer now answer with the same number.
      //
      // This used to be computed per order, each order's remainder floored at
      // zero and the positives added up. That turned one order's over-draw into
      // free portions on another. The June import gave most customers a
      // `package_size = 0` catch-all order dated 2026-06-24 carrying their whole
      // migrated delivery history, so the catch-all sits far below zero and was
      // discarded while the real packages, whose rows are all on the catch-all,
      // still read full. galvent showed 13 with 8 left; Hanna showed 18 with 4.
      //
      // Attribution is what is broken, and a customer-level balance does not
      // depend on it. `completed` is in the credit list for the same reason the
      // ledger has it there: those packages' draws are on the catch-all too, so
      // dropping their credit would charge food they paid for to the orders
      // still open.
      const LEDGER_STATUSES = [
        "active",
        "paused",
        "completed",
        "payment_proof_received",
      ];
      const bought = new Map<string, number>();
      // Candidates for the next draw, mirroring what record-daily-order feeds
      // pickDrawOrder: active orders only, keyed by undated portions.
      const drawCandidates = new Map<
        string,
        (DrawCandidate & { price: number })[]
      >();
      for (const order of orders) {
        if (!order.customer_id) continue;
        if (!LEDGER_STATUSES.includes(order.status)) continue;
        bought.set(
          order.customer_id,
          (bought.get(order.customer_id) ?? 0) + (order.package_size ?? 0),
        );
        if (order.status !== "active") continue;
        const list = drawCandidates.get(order.customer_id) ?? [];
        list.push({
          id: order.id,
          unbooked:
            (order.package_size ?? 0) - (bookedByOrder.get(order.id) ?? 0),
          start_date: order.start_date,
          created_at: order.created_at,
          price: order.price_per_portion ?? 0,
        });
        drawCandidates.set(order.customer_id, list);
      }
      // The newest *live* order, which is the only kind that may override the
      // customer's own state — see deriveCustomerDisplayState. `orders` arrives
      // newest first, so the first live one wins.
      const latestOrderByCustomer = new Map<string, Pick<Order, "status">>();
      for (const order of orders) {
        if (!order.customer_id || latestOrderByCustomer.has(order.customer_id)) {
          continue;
        }
        if (!hasCurrentOrder(order.status)) continue;
        latestOrderByCustomer.set(order.customer_id, { status: order.status });
      }

      return customers.map((customer) => {
        const remaining =
          (bought.get(customer.id) ?? 0) - (drawnByCustomer.get(customer.id) ?? 0);
        const nextOrder = pickDrawOrder(drawCandidates.get(customer.id) ?? []);
        return {
          ...customer,
          display_state: deriveCustomerDisplayState(
            customer.customer_state?.state,
            latestOrderByCustomer.get(customer.id)?.status ?? null,
          ),
          derived_remaining: Math.max(0, remaining),
          derived_next_price:
            remaining > 0 && nextOrder ? nextOrder.price : 0,
          kitchen: null,
        };
      }) as CustomerListRow[];
    },
  });

  // Kitchen names are on a different table; attaching them here keeps the list
  // query from needing a join it would otherwise only use for one column.
  const { data: allSubcontractors } = useQuery({
    queryKey: ["subcontractors-all"],
    queryFn: async () => {
      const { data } = await supabase.from("subcontractors").select("id, name");
      return data ?? [];
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    if (!allSubcontractors?.length) return data;
    const byId = new Map(allSubcontractors.map((s) => [s.id, s.name]));
    return data.map((c) => ({
      ...c,
      kitchen: c.subcontractor_id
        ? (byId.get(c.subcontractor_id) ?? null)
        : null,
    }));
  }, [data, allSubcontractors]);

  const searched = useMemo(() => {
    const needle = debouncedSearch.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (c) =>
        (c.name ?? "").toLowerCase().includes(needle) ||
        (c.phone_number ?? "").toLowerCase().includes(needle),
    );
  }, [rows, debouncedSearch]);

  const filtered = useMemo(() => {
    const active = Object.entries(filters).filter(([, f]) => isFilterActive(f));
    if (active.length === 0) return searched;
    return searched.filter((r) =>
      active.every(([key, f]) => {
        const col = COLUMN_BY_KEY.get(key);
        return !col || passesFilter(col, r, f);
      }),
    );
  }, [searched, filters]);

  const sorted = useMemo(() => {
    const col = COLUMN_BY_KEY.get(sortKey);
    if (!col) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((x, y) => {
      const a = col.value(x);
      const b = col.value(y);
      // Empty cells sort last in both directions — a customer with no area is
      // not "before A", it is missing, and burying it keeps the top of the
      // list useful whichever way the column is sorted.
      if (a === null || a === "") return b === null || b === "" ? 0 : 1;
      if (b === null || b === "") return -1;
      if (col.kind === "number") return (Number(a) - Number(b)) * dir;
      return String(a).localeCompare(String(b), "id") * dir;
    });
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = useMemo(
    () => sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [sorted, page],
  );

  /**
   * Checklist values for one column, counted over the rows that survive every
   * OTHER column's filter. That is what makes two filters compose the way a
   * spreadsheet's do: picking an area narrows the state list, but the area
   * column still offers every area, so the choice stays undoable.
   */
  const optionsFor = useCallback(
    (key: string) => {
      const col = COLUMN_BY_KEY.get(key);
      if (!col) return [];
      const others = Object.entries(filters).filter(
        ([k, f]) => k !== key && isFilterActive(f),
      );
      const pool = searched.filter((r) =>
        others.every(([k, f]) => {
          const other = COLUMN_BY_KEY.get(k);
          return !other || passesFilter(other, r, f);
        }),
      );
      const counts = new Map<string, number>();
      for (const r of pool) {
        const label = cellLabel(col, r);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => {
          if (a.value === EMPTY_LABEL) return 1;
          if (b.value === EMPTY_LABEL) return -1;
          if (col.kind === "number") return Number(a.value) - Number(b.value);
          return a.value.localeCompare(b.value, "id");
        });
    },
    [searched, filters],
  );

  function applyFilter(key: string, next: ColumnFilter | undefined) {
    const merged = { ...filters };
    if (next) merged[key] = next;
    else delete merged[key];
    setParams({ f: serializeFilters(merged) || null, page: null });
  }

  function applySort(key: string, dir: "asc" | "desc") {
    setParams({ sort: key, dir, page: null });
  }

  function toggleColumn(key: string) {
    const keys = visibleCols.map((c) => c.key);
    const next = keys.includes(key)
      ? keys.filter((k) => k !== key)
      : [...keys, key];
    if (next.length === 0) return;
    const isDefault =
      next.length === DEFAULT_COLS.length &&
      DEFAULT_COLS.every((k) => next.includes(k));
    setParams({ cols: isDefault ? null : next.join(",") });
  }

  const activeFilterCount =
    Object.values(filters).filter(isFilterActive).length;

  const saveMutation = useMutation({
    mutationFn: async (form: {
      phone_number: string;
      name: string;
      address: string;
      area: string;
      sub_area: string;
      subcontractor_id: string;
      address_type: string;
      delivery_phone: string;
      google_maps_link: string;
      meal_time_preference: string;
      ad_creative: string;
      promo_used: string;
      converted_to_subscription: boolean;
      notes: string;
      address_2: string;
      area_2: string;
      sub_area_2: string;
      google_maps_link_2: string;
      linked_order_id: string;
      contract_price_per_portion: string;
    }) => {
      if (!selected) return;
      // Through the API, not the browser client: the route is what writes the
      // edit_log row naming whoever made the change.
      const res = await fetch(`/api/customers/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone_number: form.phone_number,
          name: form.name,
          address: form.address,
          area: form.area,
          sub_area: form.sub_area || null,
          subcontractor_id: form.subcontractor_id || null,
          address_type: form.address_type || null,
          delivery_phone: form.delivery_phone || null,
          google_maps_link: form.google_maps_link || null,
          meal_time_preference: form.meal_time_preference || null,
          ad_creative: form.ad_creative || null,
          promo_used: form.promo_used || null,
          converted_to_subscription: form.converted_to_subscription,
          notes: form.notes || null,
          address_2: form.address_2 || null,
          area_2: form.area_2 || null,
          sub_area_2: form.sub_area_2 || null,
          google_maps_link_2: form.google_maps_link_2 || null,
          linked_order_id: form.linked_order_id || null,
          // Blank means ordinary tier pricing, which is what NULL means in the
          // column — an empty string would be a rate of zero.
          contract_price_per_portion: form.contract_price_per_portion.trim()
            ? Number(form.contract_price_per_portion)
            : null,
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Gagal menyimpan pelanggan");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["customers-list"] });
      setSelected(null);
    },
  });

  const createMutation = useMutation({
    mutationFn: async (form: typeof addForm) => {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Gagal membuat pelanggan");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["customers-list"] });
      setShowAdd(false);
      setAddForm({
        name: "",
        phone_number: "",
        area: "",
        sub_area: "",
        address: "",
        address_2: "",
        google_maps_link: "",
        subcontractor_id: "",
        linked_order_id: "",
      });
    },
  });

  const grantMutation = useMutation({
    mutationFn: async (rows: GrantRow[]) => {
      const res = await fetch("/api/customers/free-quota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grants: rows.map((r) => ({
            customer_id: r.customer_id,
            portions: r.portions,
            date: r.date,
            reason: r.reason.trim(),
          })),
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok)
        throw new Error(json.error ?? "Gagal menyimpan kuota gratis");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["customers-list"] });
      void queryClient.invalidateQueries({ queryKey: ["customer-ledger"] });
      setShowGrant(false);
      setGrantRows([]);
    },
  });

  const createDeliveriesMutation = useMutation({
    mutationFn: async () => {
      const deliveries = Object.entries(deliveryPortions).flatMap(
        ([date, { lunch, dinner }]) => {
          const rows: { date: string; meal_type: string; portions: number }[] =
            [];
          if (lunch > 0)
            rows.push({ date, meal_type: "lunch", portions: lunch });
          if (dinner > 0)
            rows.push({ date, meal_type: "dinner", portions: dinner });
          return rows;
        },
      );
      const res = await fetch("/api/deliveries/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: selected?.id, deliveries }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Gagal membuat pengiriman");
      return json;
    },
    onSuccess: () => {
      setDeliveryPortions({});
    },
  });

  // Save is all-or-nothing: the API validates every grant and rejects the whole
  // batch, so a single incomplete row would lose the other ninety-nine.
  const grantInvalidCount = grantRows.filter((r) => !grantRowValid(r)).length;

  function addGrantRows(count: number) {
    setGrantError(null);
    setGrantRows((rows) => [
      ...rows,
      ...Array.from({ length: count }, () =>
        newGrantRow(grantBulkDate, grantBulkReason),
      ),
    ]);
  }

  function patchGrantRow(key: string, patch: Partial<GrantRow>) {
    setGrantRows((rows) =>
      rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  }

  /**
   * Appends the pasted spreadsheet rows. A name that doesn't resolve to exactly
   * one customer is kept as text with no customer_id, so it shows up as an
   * unmatched row for the admin to pick rather than landing on the wrong ledger.
   */
  function applyGrantPaste() {
    setGrantError(null);
    const parsed = parseGrantPaste(grantPaste);
    if (parsed.length === 0) {
      setGrantError("Tidak ada baris yang bisa dibaca");
      return;
    }
    const customers = allCustomers ?? [];
    setGrantRows((rows) => [
      ...rows,
      ...parsed.map((p) => {
        const row = newGrantRow(
          p.date ?? grantBulkDate,
          p.reason || grantBulkReason,
        );
        const match = matchCustomerByName(p.name, customers);
        return {
          ...row,
          customer_id: match?.id ?? "",
          customer_name: match ? (match.name ?? p.name) : p.name,
          portions: p.portions,
        };
      }),
    ]);
    setGrantPaste("");
    setShowGrantPaste(false);
  }

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/customers/${id}`, { method: "DELETE" });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Gagal menghapus");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["customers-list"] });
      setDeleteConfirmOpen(false);
      setSelected(null);
    },
  });

  function submitAdd() {
    setAddError(null);
    if (!addForm.phone_number.trim()) {
      setAddError("Nomor telepon wajib diisi");
      return;
    }
    if (!addForm.address.trim()) {
      setAddError("Alamat wajib diisi");
      return;
    }
    createMutation.mutate(addForm, {
      onError: (e) => setAddError((e as Error).message),
    });
  }

  function openDetail(customer: Customer) {
    setSelected(customer);
    const c = customer as Customer & {
      subcontractor_id?: string | null;
      ad_creative?: string | null;
      promo_used?: string | null;
      converted_to_subscription?: boolean | null;
      notes?: string | null;
    };
    setEditForm({
      phone_number: customer.phone_number ?? "",
      name: customer.name ?? "",
      address: customer.address ?? "",
      area: customer.area ?? "",
      sub_area: customer.sub_area ?? "",
      subcontractor_id: c.subcontractor_id ?? "",
      address_type: customer.address_type ?? "",
      delivery_phone: customer.delivery_phone ?? "",
      google_maps_link: customer.google_maps_link ?? "",
      meal_time_preference: customer.meal_time_preference ?? "",
      ad_creative: c.ad_creative ?? "",
      promo_used: c.promo_used ?? "",
      converted_to_subscription: c.converted_to_subscription ?? false,
      notes: c.notes ?? "",
      address_2:
        (customer as unknown as { address_2?: string | null }).address_2 ?? "",
      area_2: (customer as unknown as { area_2?: string | null }).area_2 ?? "",
      sub_area_2:
        (customer as unknown as { sub_area_2?: string | null }).sub_area_2 ??
        "",
      google_maps_link_2:
        (customer as unknown as { google_maps_link_2?: string | null })
          .google_maps_link_2 ?? "",
      linked_order_id:
        (customer as unknown as { linked_order_id?: string | null })
          .linked_order_id ?? "",
      contract_price_per_portion: String(
        (customer as unknown as { contract_price_per_portion?: number | null })
          .contract_price_per_portion ?? "",
      ),
    });
  }

  async function saveInline(
    id: string,
    field: "name" | "area" | "sub_area",
    value: string,
  ) {
    setEditingCell(null);
    const patch =
      field === "name"
        ? { name: value || null }
        : field === "area"
          ? { area: value || null }
          : { sub_area: value || null };
    await fetch(`/api/customers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    void queryClient.invalidateQueries({ queryKey: ["customers-list"] });
  }

  // Cells that are inline-editable or specially formatted keep their own
  // rendering; everything else prints the column's own `value`, so adding a
  // column to COLUMNS is enough to make it show up.
  function renderCell(col: ColumnDef, c: CustomerListRow) {
    if (col.key === "name" || col.key === "sub_area") {
      const field = col.key as "name" | "sub_area";
      const current = (field === "name" ? c.name : c.sub_area) ?? "";
      if (editingCell?.id === c.id && editingCell.field === field) {
        const cell = editingCell;
        return (
          <Input
            autoFocus
            value={cell.value}
            onChange={(e) => setEditingCell({ ...cell, value: e.target.value })}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => saveInline(c.id, field, cell.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveInline(c.id, field, cell.value);
              if (e.key === "Escape") setEditingCell(null);
            }}
            className="w-full h-auto py-0.5 px-1 text-sm border-orange-400"
          />
        );
      }
      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setEditingCell({ id: c.id, field, value: current });
          }}
          className="cursor-text hover:underline decoration-dashed underline-offset-2 decoration-gray-300"
        >
          {current || "\u2014"}
        </button>
      );
    }

    if (col.key === "area") {
      if (editingCell?.id === c.id && editingCell.field === "area") {
        return (
          <select
            // biome-ignore lint/a11y/noAutofocus: intentional inline edit activation
            autoFocus
            value={editingCell.value}
            onChange={(e) => saveInline(c.id, "area", e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => setEditingCell(null)}
            className="text-sm border border-orange-400 rounded focus:outline-none px-1 py-0.5"
          >
            <option value="">&mdash;</option>
            {withCurrentAreas(deliveryAreas, editingCell.value).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        );
      }
      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setEditingCell({ id: c.id, field: "area", value: c.area ?? "" });
          }}
          className="cursor-pointer hover:underline decoration-dashed underline-offset-2 decoration-gray-300"
        >
          {c.area ?? "\u2014"}
        </button>
      );
    }

    if (col.key === "display_state")
      return <StateBadge state={c.display_state} />;
    if (col.key === "phone_number") return maskPhone(c.phone_number);
    if (col.key === "created_at")
      return c.created_at ? formatDate(c.created_at) : "\u2014";
    if (col.key === "derived_remaining")
      return c.derived_remaining > 0 ? c.derived_remaining : "\u2014";
    if (
      col.key === "derived_next_price" ||
      col.key === "contract_price_per_portion"
    ) {
      const n = Number(col.value(c) ?? 0);
      return n > 0 ? `Rp ${n.toLocaleString("id-ID")}` : "\u2014";
    }
    if (col.key === "notes") {
      return (
        <span className="block max-w-[16rem] truncate">
          {c.notes || "\u2014"}
        </span>
      );
    }

    const v = col.value(c);
    return v === null || v === "" ? "\u2014" : String(v);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <h1 className="text-xl font-semibold text-gray-900 mr-1">
          Customers
          <span className="ml-2 text-sm font-normal text-gray-400">
            {sorted.length === rows.length
              ? `${rows.length} total`
              : `${sorted.length} dari ${rows.length}`}
          </span>
        </h1>
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setGrantError(null);
              setGrantRows([newGrantRow(grantBulkDate, grantBulkReason)]);
              setShowGrant(true);
            }}
            className="text-sm rounded-lg"
          >
            + Grant free quota
          </Button>
          <Button
            type="button"
            onClick={() => {
              setAddError(null);
              setShowAdd(true);
            }}
            className="bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-800"
          >
            + Add customer
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or phone..."
          className="w-full sm:max-w-xs"
        />
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-lg text-sm"
            >
              <Columns3 className="mr-1.5 h-4 w-4" />
              Kolom
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-2">
            <div className="max-h-72 space-y-0.5 overflow-y-auto">
              {COLUMNS.map((col) => (
                <label
                  key={col.key}
                  htmlFor={`col-${col.key}`}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-gray-50"
                >
                  <Checkbox
                    id={`col-${col.key}`}
                    checked={visibleCols.some((c) => c.key === col.key)}
                    onCheckedChange={() => toggleColumn(col.key)}
                  />
                  <span className="flex-1 truncate">{col.label}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setParams({ cols: null })}
              className="mt-1 w-full rounded px-1 py-1 text-left text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-900"
            >
              Kembalikan kolom default
            </button>
          </PopoverContent>
        </Popover>
        {activeFilterCount > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setParams({ f: null, page: null })}
            className="h-9 rounded-lg text-sm"
          >
            Hapus {activeFilterCount} filter
          </Button>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {visibleCols.map((col) => (
                <th
                  key={col.key}
                  className={`px-4 py-3 text-xs font-medium text-gray-500 whitespace-nowrap ${
                    col.align === "right" ? "text-right" : "text-left"
                  } ${col.smOnly ? "hidden sm:table-cell" : ""}`}
                >
                  <span className="inline-flex items-center">
                    {col.label}
                    {sortKey === col.key && (
                      <span className="ml-1 text-gray-400">
                        {sortDir === "asc" ? "\u2191" : "\u2193"}
                      </span>
                    )}
                    <ColumnFilterMenu
                      label={col.label}
                      kind={col.kind}
                      options={optionsFor(col.key)}
                      filter={filters[col.key]}
                      sortDir={sortKey === col.key ? sortDir : null}
                      onSort={(dir) => applySort(col.key, dir)}
                      onChange={(next) => applyFilter(col.key, next)}
                    />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading
              ? (["a", "b", "c", "d", "e"] as const).map((rowId) => (
                  <tr key={rowId} className="border-b border-gray-50">
                    {visibleCols.map((col) => (
                      <td
                        key={col.key}
                        className={`px-4 py-3 ${col.smOnly ? "hidden sm:table-cell" : ""}`}
                      >
                        <div className="h-4 w-24 animate-pulse rounded bg-gray-100" />
                      </td>
                    ))}
                  </tr>
                ))
              : pageRows.map((c) => (
                  // biome-ignore lint/a11y/useSemanticElements: interactive table row
                  <tr
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openDetail(c)}
                    onKeyDown={(e) =>
                      (e.key === "Enter" || e.key === " ") && openDetail(c)
                    }
                    className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                  >
                    {visibleCols.map((col) => (
                      <td
                        key={col.key}
                        className={`px-4 py-3 ${
                          col.align === "right"
                            ? "text-right tabular-nums"
                            : "text-left"
                        } ${col.smOnly ? "hidden sm:table-cell" : ""} ${
                          CELL_TONE[col.key] ?? "text-gray-500"
                        }`}
                      >
                        {renderCell(col, c)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>

        {/* Pagination. The count line always names both numbers, so a
            filtered view is never mistaken for the whole list. */}
        <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setParams({ page: String(Math.max(0, page - 1)) })}
            disabled={page === 0}
          >
            Previous
          </Button>
          <span className="text-xs text-gray-400">
            {sorted.length === 0
              ? "Tidak ada pelanggan yang cocok"
              : `${page * PAGE_SIZE + 1}\u2013${Math.min((page + 1) * PAGE_SIZE, sorted.length)} dari ${sorted.length}${
                  sorted.length === rows.length ? "" : ` (${rows.length} total)`
                }`}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setParams({ page: String(Math.min(totalPages - 1, page + 1)) })
            }
            disabled={page >= totalPages - 1}
          >
            Next
          </Button>
        </div>
      </div>

      {/* Add customer modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Pelanggan Baru</h2>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowAdd(false)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none h-auto w-auto p-0"
              >
                &times;
              </Button>
            </div>

            <div>
              <Label
                htmlFor="add-phone"
                className="text-xs text-gray-500 block mb-1"
              >
                Phone *
              </Label>
              <Input
                id="add-phone"
                value={addForm.phone_number}
                onChange={(e) =>
                  setAddForm({ ...addForm, phone_number: e.target.value })
                }
                placeholder="+628..."
              />
            </div>
            <div>
              <Label
                htmlFor="add-name"
                className="text-xs text-gray-500 block mb-1"
              >
                Name
              </Label>
              <Input
                id="add-name"
                value={addForm.name}
                onChange={(e) =>
                  setAddForm({ ...addForm, name: e.target.value })
                }
              />
            </div>
            <div>
              <Label
                htmlFor="add-address"
                className="text-xs text-gray-500 block mb-1"
              >
                Address *
              </Label>
              <Textarea
                id="add-address"
                value={addForm.address}
                onChange={(e) =>
                  setAddForm({ ...addForm, address: e.target.value })
                }
                rows={2}
                className="resize-none"
              />
            </div>
            <div>
              <Label
                htmlFor="add-address-2"
                className="text-xs text-gray-500 block mb-1"
              >
                Address 2 (opsional)
              </Label>
              <Textarea
                id="add-address-2"
                value={addForm.address_2}
                onChange={(e) =>
                  setAddForm({ ...addForm, address_2: e.target.value })
                }
                rows={2}
                className="resize-none"
              />
            </div>
            <div>
              <Label
                htmlFor="add-area"
                className="text-xs text-gray-500 block mb-1"
              >
                Area
              </Label>
              <select
                id="add-area"
                value={addForm.area}
                onChange={(e) =>
                  setAddForm({ ...addForm, area: e.target.value })
                }
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                <option value="">— Select area —</option>
                {withCurrentAreas(deliveryAreas, addForm.area).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label
                htmlFor="add-sub-area"
                className="text-xs text-gray-500 block mb-1"
              >
                Sub Area
              </Label>
              <Input
                id="add-sub-area"
                value={addForm.sub_area}
                onChange={(e) =>
                  setAddForm({ ...addForm, sub_area: e.target.value })
                }
                placeholder="e.g. Binus, Pacific Garden"
              />
            </div>
            <div>
              <Label
                htmlFor="add-maps"
                className="text-xs text-gray-500 block mb-1"
              >
                Google Maps Link
              </Label>
              <Input
                id="add-maps"
                value={addForm.google_maps_link}
                onChange={(e) =>
                  setAddForm({ ...addForm, google_maps_link: e.target.value })
                }
              />
            </div>
            <div>
              <Label
                htmlFor="add-sub"
                className="text-xs text-gray-500 block mb-1"
              >
                Assigned Subcontractor
              </Label>
              <select
                id="add-sub"
                value={addForm.subcontractor_id}
                onChange={(e) =>
                  setAddForm({ ...addForm, subcontractor_id: e.target.value })
                }
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                <option value="">— None —</option>
                {(subcontractors ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label
                htmlFor="add-linked-order"
                className="text-xs text-gray-500 block mb-1"
              >
                Draws From Another Customer&apos;s Balance
              </Label>
              <select
                id="add-linked-order"
                value={addForm.linked_order_id}
                onChange={(e) =>
                  setAddForm({ ...addForm, linked_order_id: e.target.value })
                }
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                <option value="">— Own package (default) —</option>
                {(linkableCustomers ?? []).map((c) => (
                  <option key={c.id} value={c.active_order_id ?? ""}>
                    {c.name ?? c.id}
                  </option>
                ))}
              </select>
            </div>

            {addError && <p className="text-xs text-red-600">{addError}</p>}

            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                onClick={submitAdd}
                disabled={createMutation.isPending}
                className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-40"
              >
                {createMutation.isPending ? "Menyimpan..." : "Simpan"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowAdd(false)}
                className="flex-1 py-2 border-gray-200 text-sm rounded-lg"
              >
                Batal
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Grant free quota modal */}
      {showGrant && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-5xl space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Grant Free Quota</h2>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowGrant(false)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none h-auto w-auto p-0"
              >
                &times;
              </Button>
            </div>

            {/* Bulk defaults — applied to new rows, and to every row on demand,
                because a backfill is usually one date and one reason. */}
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label className="text-xs text-gray-500 block mb-1">
                  Default date
                </Label>
                <Input
                  type="date"
                  value={grantBulkDate}
                  onChange={(e) => setGrantBulkDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <div className="flex-1 min-w-[12rem]">
                <Label className="text-xs text-gray-500 block mb-1">
                  Default reason
                </Label>
                <Input
                  list="grant-reasons"
                  value={grantBulkReason}
                  onChange={(e) => setGrantBulkReason(e.target.value)}
                  placeholder="Pilih atau ketik alasan..."
                />
                <datalist id="grant-reasons">
                  {GRANT_REASONS.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setGrantRows((rows) =>
                    rows.map((r) => ({
                      ...r,
                      date: grantBulkDate,
                      reason: grantBulkReason || r.reason,
                    })),
                  )
                }
                disabled={grantRows.length === 0}
                className="text-sm rounded-lg"
              >
                Apply to all rows
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => addGrantRows(1)}
                className="text-sm rounded-lg"
              >
                + Add row
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => addGrantRows(10)}
                className="text-sm rounded-lg"
              >
                + Add 10 rows
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowGrantPaste((v) => !v)}
                className="text-sm rounded-lg"
              >
                Paste from spreadsheet
              </Button>
              {grantRows.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setGrantRows([])}
                  className="text-sm text-gray-500 hover:text-red-600 rounded-lg"
                >
                  Clear all
                </Button>
              )}
            </div>

            {showGrantPaste && (
              <div className="space-y-2 border border-gray-100 rounded-lg p-3">
                <p className="text-xs text-gray-500">
                  One row per line, columns:{" "}
                  <span className="font-mono">
                    nama · porsi · tanggal · alasan
                  </span>
                  . Tanggal dan alasan opsional. Angka negatif dibaca sebagai
                  besarnya kekurangan (−3 = 3 porsi). Nama yang tidak cocok
                  persis akan ditandai untuk dipilih manual.
                </p>
                <Textarea
                  rows={6}
                  value={grantPaste}
                  onChange={(e) => setGrantPaste(e.target.value)}
                  placeholder={
                    "Defi Lugito\t6\t2026-08-14\tkompensasi\nValen\t4"
                  }
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={applyGrantPaste}
                  disabled={!grantPaste.trim()}
                  className="text-sm rounded-lg"
                >
                  Add pasted rows
                </Button>
              </div>
            )}

            {grantError && <p className="text-xs text-red-600">{grantError}</p>}

            {grantRows.length > 0 && (
              <div className="border border-gray-100 rounded-lg">
                <div className="grid grid-cols-[2rem_1fr_5rem_9rem_1fr_2rem] gap-2 px-3 py-2 text-xs text-gray-500 border-b border-gray-100">
                  <span>#</span>
                  <span>Customer</span>
                  <span>Porsi</span>
                  <span>Tanggal</span>
                  <span>Alasan</span>
                  <span />
                </div>
                {grantRows.map((r, i) => (
                  <div
                    key={r.key}
                    className="grid grid-cols-[2rem_1fr_5rem_9rem_1fr_2rem] gap-2 px-3 py-1.5 items-center border-b border-gray-50 last:border-0"
                  >
                    <span className="text-xs text-gray-400">{i + 1}</span>
                    <div className="relative">
                      <Input
                        value={r.customer_name}
                        onChange={(e) => {
                          patchGrantRow(r.key, {
                            customer_id: "",
                            customer_name: e.target.value,
                          });
                          setGrantOpenRow(r.key);
                        }}
                        onFocus={() => setGrantOpenRow(r.key)}
                        onBlur={() =>
                          setGrantOpenRow((k) => (k === r.key ? null : k))
                        }
                        placeholder="Nama atau nomor..."
                        className={
                          r.customer_id
                            ? "h-8 text-sm"
                            : "h-8 text-sm border-amber-400 bg-amber-50"
                        }
                      />
                      {grantOpenRow === r.key && (
                        <ul className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg text-sm">
                          {(allCustomers ?? [])
                            .filter((c) => {
                              const q = r.customer_name.toLowerCase();
                              if (!q) return true;
                              return (
                                (c.name ?? "").toLowerCase().includes(q) ||
                                (c.phone_number ?? "").toLowerCase().includes(q)
                              );
                            })
                            .slice(0, 20)
                            .map((c) => (
                              <li key={c.id}>
                                <button
                                  type="button"
                                  onMouseDown={() => {
                                    patchGrantRow(r.key, {
                                      customer_id: c.id,
                                      customer_name:
                                        c.name ?? c.phone_number ?? c.id,
                                    });
                                    setGrantOpenRow(null);
                                  }}
                                  className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
                                >
                                  {c.name ?? "—"}{" "}
                                  <span className="text-gray-400">
                                    {c.phone_number}
                                  </span>
                                </button>
                              </li>
                            ))}
                        </ul>
                      )}
                    </div>
                    <Input
                      type="number"
                      min={1}
                      value={r.portions ?? ""}
                      onChange={(e) =>
                        patchGrantRow(r.key, {
                          portions:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                      className="h-8 text-sm"
                    />
                    <Input
                      type="date"
                      value={r.date}
                      onChange={(e) =>
                        patchGrantRow(r.key, { date: e.target.value })
                      }
                      className="h-8 text-sm"
                    />
                    <Input
                      list="grant-reasons"
                      value={r.reason}
                      onChange={(e) =>
                        patchGrantRow(r.key, { reason: e.target.value })
                      }
                      placeholder="Alasan"
                      className="h-8 text-sm"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        setGrantRows((rows) =>
                          rows.filter((row) => row.key !== r.key),
                        )
                      }
                      className="text-gray-400 hover:text-red-600 text-lg leading-none h-auto w-auto p-0"
                    >
                      &times;
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {grantRows.length > 0 && grantInvalidCount > 0 && (
              <p className="text-xs text-amber-700">
                {grantInvalidCount} baris belum lengkap (pelanggan, porsi &gt;
                0, dan alasan wajib diisi).
              </p>
            )}

            {grantMutation.isError && (
              <p className="text-xs text-red-600">
                {(grantMutation.error as Error).message}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                onClick={() => grantMutation.mutate(grantRows)}
                disabled={
                  grantRows.length === 0 ||
                  grantInvalidCount > 0 ||
                  grantMutation.isPending
                }
                className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-40"
              >
                {grantMutation.isPending
                  ? "Menyimpan..."
                  : `Save ${grantRows.length || ""} grant${grantRows.length === 1 ? "" : "s"}`}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowGrant(false)}
                className="flex-1 py-2 border-gray-200 text-sm rounded-lg"
              >
                Batal
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Detail slide-over */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            aria-label="Close"
            className="absolute inset-0 h-auto w-auto rounded-none bg-black/20 cursor-default hover:bg-black/20"
            onClick={() => setSelected(null)}
          />
          <div className="relative w-full max-w-md bg-white shadow-xl overflow-y-auto">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                Customer Detail
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelected(null)}
                className="text-gray-400 hover:text-gray-600 h-auto p-0"
              >
                ✕
              </Button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <Label
                  htmlFor="customer-phone"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Phone
                </Label>
                <Input
                  id="customer-phone"
                  value={editForm.phone_number}
                  onChange={(e) =>
                    setEditForm({ ...editForm, phone_number: e.target.value })
                  }
                />
              </div>

              <div>
                <Label
                  htmlFor="customer-name"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Name
                </Label>
                <Input
                  id="customer-name"
                  value={editForm.name}
                  onChange={(e) =>
                    setEditForm({ ...editForm, name: e.target.value })
                  }
                />
              </div>

              <div>
                <Label
                  htmlFor="customer-address"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Address
                </Label>
                <Textarea
                  id="customer-address"
                  value={editForm.address}
                  onChange={(e) =>
                    setEditForm({ ...editForm, address: e.target.value })
                  }
                  rows={2}
                  className="resize-none"
                />
              </div>

              <div>
                <Label
                  htmlFor="customer-area"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Area
                </Label>
                <select
                  id="customer-area"
                  value={editForm.area}
                  onChange={(e) =>
                    setEditForm({ ...editForm, area: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— Select area —</option>
                  {withCurrentAreas(deliveryAreas, editForm.area).map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label
                  htmlFor="customer-sub-area"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Sub Area
                </Label>
                <Input
                  id="customer-sub-area"
                  value={editForm.sub_area}
                  onChange={(e) =>
                    setEditForm({ ...editForm, sub_area: e.target.value })
                  }
                  placeholder="e.g. Binus, Pacific Garden"
                />
              </div>

              <div>
                <Label
                  htmlFor="customer-subcontractor"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Assigned Subcontractor
                </Label>
                <select
                  id="customer-subcontractor"
                  value={editForm.subcontractor_id}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      subcontractor_id: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— None —</option>
                  {(subcontractors ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label
                  htmlFor="customer-linked-order"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Draws From Another Customer&apos;s Balance
                </Label>
                <select
                  id="customer-linked-order"
                  value={editForm.linked_order_id}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      linked_order_id: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— Own package (default) —</option>
                  {(linkableCustomers ?? [])
                    .filter((c) => c.id !== selected?.id)
                    .map((c) => (
                      <option key={c.id} value={c.active_order_id ?? ""}>
                        {c.name ?? c.id}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <Label
                  htmlFor="customer-contract-price"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Harga Kontrak / Porsi
                </Label>
                <Input
                  id="customer-contract-price"
                  type="number"
                  inputMode="numeric"
                  placeholder="Kosong = harga paket biasa"
                  value={editForm.contract_price_per_portion}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      contract_price_per_portion: e.target.value,
                    })
                  }
                  className="w-full"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Pelanggan korporat: harga ini menggantikan daftar harga paket,
                  dan jumlah porsi bebas (tidak harus kelipatan 5 atau 6).
                </p>
              </div>

              <div>
                <Label
                  htmlFor="customer-address-type"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Address Type
                </Label>
                <Input
                  id="customer-address-type"
                  value={editForm.address_type}
                  onChange={(e) =>
                    setEditForm({ ...editForm, address_type: e.target.value })
                  }
                  placeholder="e.g. Rumah, Apartment, Kantor"
                />
              </div>

              <div>
                <Label
                  htmlFor="customer-delivery-phone"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Delivery Phone
                </Label>
                <Input
                  id="customer-delivery-phone"
                  value={editForm.delivery_phone}
                  onChange={(e) =>
                    setEditForm({ ...editForm, delivery_phone: e.target.value })
                  }
                  placeholder="Alternative phone for delivery"
                />
              </div>

              <div>
                <Label
                  htmlFor="customer-maps-link"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Google Maps Link
                </Label>
                <Input
                  id="customer-maps-link"
                  value={editForm.google_maps_link}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      google_maps_link: e.target.value,
                    })
                  }
                  placeholder="https://maps.app.goo.gl/..."
                />
              </div>

              <div className="pt-1 pb-0.5">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  Address 2
                </p>
              </div>

              <div>
                <Label
                  htmlFor="customer-address-2"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Address 2
                </Label>
                <Textarea
                  id="customer-address-2"
                  value={editForm.address_2}
                  onChange={(e) =>
                    setEditForm({ ...editForm, address_2: e.target.value })
                  }
                  rows={2}
                  className="resize-none"
                />
              </div>

              <div>
                <Label
                  htmlFor="customer-area-2"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Area 2
                </Label>
                <select
                  id="customer-area-2"
                  value={editForm.area_2}
                  onChange={(e) =>
                    setEditForm({ ...editForm, area_2: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— Not set —</option>
                  {withCurrentAreas(deliveryAreas, editForm.area_2).map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label
                  htmlFor="customer-sub-area-2"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Sub Area 2
                </Label>
                <Input
                  id="customer-sub-area-2"
                  value={editForm.sub_area_2}
                  onChange={(e) =>
                    setEditForm({ ...editForm, sub_area_2: e.target.value })
                  }
                />
              </div>

              <div>
                <Label
                  htmlFor="customer-maps-link-2"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Google Maps Link 2
                </Label>
                <Input
                  id="customer-maps-link-2"
                  value={editForm.google_maps_link_2}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      google_maps_link_2: e.target.value,
                    })
                  }
                  placeholder="https://maps.app.goo.gl/..."
                />
              </div>

              <div>
                <Label
                  htmlFor="customer-meal-time"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Meal Time Preference
                </Label>
                <select
                  id="customer-meal-time"
                  value={editForm.meal_time_preference}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      meal_time_preference: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— Not set —</option>
                  <option value="lunch_only">Lunch only</option>
                  <option value="dinner_only">Dinner only</option>
                  <option value="both_fixed">Both (fixed)</option>
                  <option value="per_day_decision">Per-day decision</option>
                  <option value="default_lunch">Default lunch</option>
                  <option value="default_dinner">Default dinner</option>
                  <option value="custom_schedule">Custom schedule</option>
                </select>
              </div>

              <div>
                <Label className="text-xs text-gray-500 block mb-1">
                  Ad Creative
                </Label>
                <Input
                  value={editForm.ad_creative}
                  onChange={(e) =>
                    setEditForm({ ...editForm, ad_creative: e.target.value })
                  }
                  placeholder="e.g. C4"
                />
              </div>

              <div>
                <Label className="text-xs text-gray-500 block mb-1">
                  Promo Used
                </Label>
                <Input
                  value={editForm.promo_used}
                  onChange={(e) =>
                    setEditForm({ ...editForm, promo_used: e.target.value })
                  }
                  placeholder="e.g. Rp17k porsi pertama"
                />
              </div>

              <div className="flex items-center gap-3">
                <input
                  id="converted-to-subscription"
                  type="checkbox"
                  checked={editForm.converted_to_subscription}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      converted_to_subscription: e.target.checked,
                    })
                  }
                  className="h-4 w-4 rounded border-gray-300 accent-orange-500"
                />
                <Label
                  htmlFor="converted-to-subscription"
                  className="text-sm text-gray-700"
                >
                  Converted to subscription
                </Label>
              </div>

              <div>
                <Label className="text-xs text-gray-500 block mb-1">
                  Notes
                </Label>
                <Textarea
                  value={editForm.notes}
                  onChange={(e) =>
                    setEditForm({ ...editForm, notes: e.target.value })
                  }
                  rows={3}
                  className="resize-none"
                />
              </div>

              {/* Draw ledger — every package credit (+N) and daily draw (−N) */}
              <div className="pt-2 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                  Riwayat pemakaian
                </p>
                {ledgerLoading ? (
                  <p className="text-xs text-gray-400">Memuat…</p>
                ) : !ledger || ledger.rows.length === 0 ? (
                  <p className="text-xs text-gray-400">Belum ada transaksi.</p>
                ) : (
                  <div className="border border-gray-100 rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 text-gray-500">
                        <tr>
                          <th className="text-left font-medium px-2 py-1.5">
                            Tanggal
                          </th>
                          <th className="text-left font-medium px-2 py-1.5">
                            Keterangan
                          </th>
                          <th className="text-right font-medium px-2 py-1.5">
                            Jumlah
                          </th>
                          <th className="text-right font-medium px-2 py-1.5">
                            Sisa
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledger.rows.map((r) => (
                          <tr
                            key={r.id}
                            className={`border-t border-gray-50 ${r.scheduled ? "text-gray-400" : "text-gray-700"}`}
                          >
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {formatDate(r.date)}
                            </td>
                            <td className="px-2 py-1.5">
                              {r.kind === "package" ? (
                                <span className="font-medium text-gray-900">
                                  {r.label}
                                </span>
                              ) : (
                                <span className="capitalize">
                                  {r.meal_type ?? "draw"}
                                  {r.scheduled ? " · terjadwal" : ""}
                                </span>
                              )}
                            </td>
                            <td
                              className={`px-2 py-1.5 text-right font-medium tabular-nums ${r.change < 0 ? "text-red-600" : "text-green-600"}`}
                            >
                              {r.change > 0 ? `+${r.change}` : r.change}
                            </td>
                            <td
                              className={`px-2 py-1.5 text-right tabular-nums ${r.balance < 0 ? "text-red-600" : ""}`}
                            >
                              {r.balance}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-gray-50 border-t-2 border-gray-200 text-gray-700 font-medium">
                        <tr className="border-t border-gray-100">
                          <td colSpan={2} className="px-2 py-1.5 text-gray-500">
                            Total masuk
                          </td>
                          <td className="px-2 py-1.5 text-right text-green-600 tabular-nums">
                            +{ledger.totalPackage}
                          </td>
                          <td />
                        </tr>
                        <tr className="border-t border-gray-100">
                          <td colSpan={2} className="px-2 py-1.5 text-gray-500">
                            Total keluar
                          </td>
                          <td className="px-2 py-1.5 text-right text-red-600 tabular-nums">
                            -{ledger.totalDrawn}
                          </td>
                          <td />
                        </tr>
                        <tr className="border-t-2 border-gray-200">
                          <td colSpan={3} className="px-2 py-1.5 text-gray-500">
                            Sisa hari ini
                          </td>
                          <td
                            className={`px-2 py-1.5 text-right font-semibold tabular-nums ${ledger.balanceToday < 0 ? "text-red-600" : "text-gray-900"}`}
                          >
                            {ledger.balanceToday}
                          </td>
                        </tr>
                        {ledger.balance !== ledger.balanceToday && (
                          <tr className="border-t border-gray-100">
                            <td
                              colSpan={3}
                              className="px-2 py-1.5 text-gray-500"
                            >
                              Setelah terjadwal
                            </td>
                            <td
                              className={`px-2 py-1.5 text-right font-semibold tabular-nums ${ledger.balance < 0 ? "text-red-600" : "text-gray-900"}`}
                            >
                              {ledger.balance}
                            </td>
                          </tr>
                        )}
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>

              {(selected as Customer & { converted_at?: string | null })
                ?.converted_at && (
                <p className="text-xs text-gray-400">
                  Converted:{" "}
                  {new Date(
                    (selected as Customer & { converted_at?: string })
                      .converted_at as string,
                  ).toLocaleDateString("id-ID", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </p>
              )}

              {saveMutation.isError && (
                <p className="text-sm text-red-600">
                  Failed to save. Please try again.
                </p>
              )}

              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDeliveryPortions({});
                  createDeliveriesMutation.reset();
                  setShowDeliveryModal(true);
                }}
                className="w-full border-gray-200 text-gray-700 hover:bg-gray-50"
              >
                Create deliveries
              </Button>

              <Button
                type="button"
                onClick={() => saveMutation.mutate(editForm)}
                disabled={saveMutation.isPending}
                className="w-full bg-orange-500 hover:bg-orange-600"
              >
                {saveMutation.isPending ? "Saving..." : "Save changes"}
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteConfirmOpen(true)}
                className="w-full border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
              >
                Delete customer
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Create deliveries modal */}
      {showDeliveryModal &&
        selected &&
        (() => {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const firstDay = new Date(calYear, calMonth, 1).getDay();
          const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

          function dKey(y: number, m: number, d: number) {
            return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          }
          function getP(k: string) {
            return deliveryPortions[k] ?? { lunch: 0, dinner: 0 };
          }
          function stepP(k: string, meal: "lunch" | "dinner", delta: number) {
            const cur = getP(k);
            setDeliveryPortions((prev) => ({
              ...prev,
              [k]: { ...cur, [meal]: Math.max(0, cur[meal] + delta) },
            }));
          }

          const allEntries = Object.entries(deliveryPortions);
          let totalLunch = 0;
          let totalDinner = 0;
          let activeDates = 0;
          for (const [, { lunch, dinner }] of allEntries) {
            if (lunch > 0 || dinner > 0) {
              activeDates++;
              totalLunch += lunch;
              totalDinner += dinner;
            }
          }
          const total = totalLunch + totalDinner;

          return (
            <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
              <button
                type="button"
                aria-label="Close"
                className="absolute inset-0 bg-black/40 cursor-default"
                onClick={() => setShowDeliveryModal(false)}
              />
              <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-gray-900">
                      Create deliveries — {selected.name}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <span className="inline-block w-2 h-2 rounded-full bg-orange-400" />
                        Lunch
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
                        Dinner
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (calMonth === 0) {
                          setCalMonth(11);
                          setCalYear((y) => y - 1);
                        } else setCalMonth((m) => m - 1);
                      }}
                      className="w-7 h-7 flex items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 text-sm"
                    >
                      ‹
                    </button>
                    <span className="text-sm font-medium w-32 text-center tabular-nums">
                      {MONTHS[calMonth]} {calYear}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (calMonth === 11) {
                          setCalMonth(0);
                          setCalYear((y) => y + 1);
                        } else setCalMonth((m) => m + 1);
                      }}
                      className="w-7 h-7 flex items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 text-sm"
                    >
                      ›
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowDeliveryModal(false)}
                      className="ml-2 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 text-sm"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Calendar */}
                <div className="p-4">
                  {/* Day labels */}
                  <div className="grid grid-cols-7 gap-1 mb-1">
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                      (d) => (
                        <div
                          key={d}
                          className="text-center text-[10px] font-semibold text-gray-400 uppercase tracking-wide py-1"
                        >
                          {d}
                        </div>
                      ),
                    )}
                  </div>
                  {/* Grid */}
                  <div className="grid grid-cols-7 gap-1">
                    {/* No blank placeholder cells: the 1st is pushed to its
                      weekday column instead, so every child has a real key. */}
                    {Array.from({ length: daysInMonth }, (_, i) => {
                      const day = i + 1;
                      const k = dKey(calYear, calMonth, day);
                      const { lunch, dinner } = getP(k);
                      const isActive = lunch > 0 || dinner > 0;
                      const cellDate = new Date(calYear, calMonth, day);
                      const isToday = cellDate.getTime() === today.getTime();
                      return (
                        <div
                          key={k}
                          style={
                            day === 1
                              ? { gridColumnStart: firstDay + 1 }
                              : undefined
                          }
                          className={`border rounded-lg p-1.5 flex flex-col gap-1 min-h-[72px] transition-colors ${
                            isActive
                              ? "bg-orange-50 border-orange-200"
                              : "border-gray-100"
                          }`}
                        >
                          <span
                            className={`text-[11px] font-semibold leading-none ${isToday ? "text-blue-500" : "text-gray-400"}`}
                          >
                            {day}
                          </span>
                          <div className="flex gap-1 flex-1 items-end">
                            {/* Lunch */}
                            <div className="flex-1 flex flex-col items-center gap-0.5">
                              <span className="text-[9px] font-bold text-orange-500 leading-none">
                                L
                              </span>
                              <div className="w-full flex items-center bg-orange-100 rounded px-0.5 py-0.5 gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => stepP(k, "lunch", -1)}
                                  className="w-3.5 h-3.5 flex items-center justify-center text-orange-500 text-xs font-bold leading-none hover:bg-orange-200 rounded"
                                >
                                  −
                                </button>
                                <span
                                  className={`flex-1 text-center text-[11px] font-bold leading-none tabular-nums ${lunch === 0 ? "text-orange-300" : "text-orange-600"}`}
                                >
                                  {lunch}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => stepP(k, "lunch", 1)}
                                  className="w-3.5 h-3.5 flex items-center justify-center text-orange-500 text-xs font-bold leading-none hover:bg-orange-200 rounded"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                            {/* Dinner */}
                            <div className="flex-1 flex flex-col items-center gap-0.5">
                              <span className="text-[9px] font-bold text-blue-500 leading-none">
                                D
                              </span>
                              <div className="w-full flex items-center bg-blue-100 rounded px-0.5 py-0.5 gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => stepP(k, "dinner", -1)}
                                  className="w-3.5 h-3.5 flex items-center justify-center text-blue-500 text-xs font-bold leading-none hover:bg-blue-200 rounded"
                                >
                                  −
                                </button>
                                <span
                                  className={`flex-1 text-center text-[11px] font-bold leading-none tabular-nums ${dinner === 0 ? "text-blue-300" : "text-blue-600"}`}
                                >
                                  {dinner}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => stepP(k, "dinner", 1)}
                                  className="w-3.5 h-3.5 flex items-center justify-center text-blue-500 text-xs font-bold leading-none hover:bg-blue-200 rounded"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Footer */}
                <div className="border-t border-gray-100 px-5 py-3.5 flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-xs text-gray-500 leading-relaxed">
                    {total === 0 ? (
                      <span className="italic text-gray-400">
                        No deliveries selected
                      </span>
                    ) : (
                      <>
                        {totalLunch > 0 && (
                          <span className="text-orange-500 font-semibold">
                            {totalLunch} lunch
                          </span>
                        )}
                        {totalLunch > 0 && totalDinner > 0 && (
                          <span className="text-gray-400"> + </span>
                        )}
                        {totalDinner > 0 && (
                          <span className="text-blue-500 font-semibold">
                            {totalDinner} dinner
                          </span>
                        )}
                        <span className="text-gray-400"> across </span>
                        <span className="font-semibold text-gray-700">
                          {activeDates} date{activeDates !== 1 ? "s" : ""}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {createDeliveriesMutation.isError && (
                      <span className="text-xs text-red-600">
                        {(createDeliveriesMutation.error as Error).message}
                      </span>
                    )}
                    {createDeliveriesMutation.isSuccess && (
                      <span className="text-xs text-green-600">Created.</span>
                    )}
                    <Button
                      type="button"
                      onClick={() => createDeliveriesMutation.mutate()}
                      disabled={
                        total === 0 || createDeliveriesMutation.isPending
                      }
                      className="bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-sm"
                    >
                      {createDeliveriesMutation.isPending
                        ? "Creating..."
                        : `Create ${total || ""} deliver${total === 1 ? "y" : "ies"}`}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

      {/* Delete customer confirm */}
      {deleteConfirmOpen && selected && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <Button
            type="button"
            variant="ghost"
            aria-label="Close"
            className="absolute inset-0 h-auto w-auto rounded-none bg-black/40 cursor-default hover:bg-black/40"
            onClick={() => setDeleteConfirmOpen(false)}
          />
          <div className="relative w-full max-w-sm bg-white rounded-lg shadow-xl p-5 space-y-4">
            <h3 className="text-sm font-semibold text-gray-900">
              Delete customer?
            </h3>
            <p className="text-sm text-gray-600">
              This permanently deletes{" "}
              <span className="font-medium">
                {selected.name ?? "this customer"}
              </span>{" "}
              along with their orders, deliveries, conversations, and state.
              This cannot be undone.
            </p>
            {deleteMutation.isError && (
              <p className="text-sm text-red-600">
                {(deleteMutation.error as Error).message}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteConfirmOpen(false)}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => deleteMutation.mutate(selected.id)}
                disabled={deleteMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                {deleteMutation.isPending
                  ? "Deleting..."
                  : "Delete permanently"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    new: "bg-gray-100 text-gray-600",
    ordering: "bg-yellow-50 text-yellow-700",
    pending_payment: "bg-orange-50 text-orange-700",
    payment_proof_received: "bg-indigo-50 text-indigo-700",
    active: "bg-green-50 text-green-700",
    paused: "bg-gray-100 text-gray-600",
    completed: "bg-gray-100 text-gray-500",
    cancelled_unpaid: "bg-red-50 text-red-600",
    cancelled_by_customer: "bg-red-50 text-red-600",
    cancelled_by_admin: "bg-red-50 text-red-600",
    refunded: "bg-red-50 text-red-600",
    lapsed: "bg-red-50 text-red-600",
    churned: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${colors[state] ?? "bg-gray-100 text-gray-600"}`}
    >
      {state.replace(/_/g, " ")}
    </span>
  );
}
