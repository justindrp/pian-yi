"use client";

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DeliveryRow {
  id?: string;
  customer_id: string;
  order_id: string;
  meal_type: "lunch" | "dinner";
  portions: number;
  subcontractor_id: string | null;
  notes: string | null;
  status: string;
  skip: boolean;
  address_slot: number;
  customers?: {
    name: string | null;
    phone_number: string;
    area: string;
    sub_area: string | null;
    address: string | null;
    google_maps_link: string | null;
    address_2: string | null;
    area_2: string | null;
    sub_area_2: string | null;
    google_maps_link_2: string | null;
    subcontractor_id: string | null;
    delivery_route: number | null;
    delivery_position: number | null;
  };
  orders?: { portions_lunch: number; portions_dinner: number; portions_per_delivery: number; meal_time_preference: string; size?: string };
}

interface Proof {
  id: string;
  caption: string | null;
  image_url: string | null;
  signed_url: string | null;
  status: string;
  match_confidence: number | null;
  sent_to_customer_at: string | null;
  sent_by: string | null;
  subcontractors: { name: string } | null;
  customers: { name: string | null; phone_number: string } | null;
  matched_customer_id: string | null;
}

interface Sub { id: string; name: string }

interface AddableCustomer {
  id: string;
  name: string | null;
  phone_number: string;
  area: string;
  sub_area: string | null;
  address: string | null;
  google_maps_link: string | null;
  address_2: string | null;
  area_2: string | null;
  sub_area_2: string | null;
  google_maps_link_2: string | null;
  subcontractor_id: string | null;
  delivery_route: number | null;
  delivery_position: number | null;
  active_order: {
    id: string;
    portions_per_delivery: number;
    portions_lunch: number | null;
    portions_dinner: number | null;
  };
}

// Radix Select forbids an empty-string item value; use this sentinel for "no subcontractor".
const NO_SUB = "__none__";

const ROUTE_LABELS: Record<number, string> = {
  1: "Route 1 — Alam Sutera & BSD Lama",
  2: "Route 2 — Gading Serpong & BSD Baru",
};

function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function isPastDeadline(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const deadline = new Date(y, m - 1, d - 1, 20, 0, 0);
  return new Date() > deadline;
}

// Returns unique customer IDs for a route, sorted by delivery_position
function getRouteSortedIds(rows: DeliveryRow[], route: number): string[] {
  const seen = new Set<string>();
  return rows
    .filter((r) => r.customers?.delivery_route === route)
    .sort((a, b) => (a.customers?.delivery_position ?? 0) - (b.customers?.delivery_position ?? 0))
    .reduce<string[]>((acc, r) => {
      if (!seen.has(r.customer_id)) { seen.add(r.customer_id); acc.push(r.customer_id); }
      return acc;
    }, []);
}

function getRouteMealRows(rows: DeliveryRow[], route: number, meal: "lunch" | "dinner"): DeliveryRow[] {
  return rows
    .filter((r) => r.meal_type === meal && r.customers?.delivery_route === route)
    .sort((a, b) => (a.customers?.delivery_position ?? 0) - (b.customers?.delivery_position ?? 0));
}

function getUnassignedMealRows(rows: DeliveryRow[], meal: "lunch" | "dinner"): DeliveryRow[] {
  return rows.filter((r) => r.meal_type === meal && !r.customers?.delivery_route);
}

function buildSubcontractorSummary(rows: DeliveryRow[], subs: Sub[], subId: string, date: string): string {
  const sub = subs.find((s) => s.id === subId);
  const subRows = rows.filter((r) => r.subcontractor_id === subId && !r.skip);
  const lunch = subRows
    .filter((r) => r.meal_type === "lunch")
    .sort((a, b) => (a.customers?.delivery_position ?? 0) - (b.customers?.delivery_position ?? 0));
  const dinner = subRows
    .filter((r) => r.meal_type === "dinner")
    .sort((a, b) => (a.customers?.delivery_position ?? 0) - (b.customers?.delivery_position ?? 0));
  const total = subRows.reduce((s, r) => s + r.portions, 0);
  const dateStr = new Date(date).toLocaleDateString("id-ID", { day: "numeric", month: "long" });
  let text = `🍱 *Pengiriman ${sub?.name ?? subId} - ${dateStr}*\n`;
  if (lunch.length) {
    text += "\n*LUNCH*\n";
    lunch.forEach((r, i) => {
      text += `${i + 1}. ${r.customers?.name ?? "?"} - ${r.customers?.area ?? "?"} - ${r.portions} porsi\n`;
    });
  }
  if (dinner.length) {
    text += "\n*DINNER*\n";
    dinner.forEach((r, i) => {
      text += `${i + 1}. ${r.customers?.name ?? "?"} - ${r.customers?.area ?? "?"} - ${r.portions} porsi\n`;
    });
  }
  text += `\nTotal: ${total} porsi`;
  return text;
}

function buildRouteMealSummary(rows: DeliveryRow[], route: number, meal: "lunch" | "dinner", date: string): string {
  const mealRows = getRouteMealRows(rows.filter((r) => !r.skip), route, meal);
  const dateStr = new Date(date).toLocaleDateString("id-ID", { day: "numeric", month: "long" });
  const mealLabel = meal === "lunch" ? "Lunch" : "Dinner";
  const totalPortions = mealRows.reduce((s, r) => s + r.portions, 0);
  let text = `🛵 *Rute ${route} ${mealLabel} - ${dateStr} = ${totalPortions} porsi*\n\n`;
  mealRows.forEach((r, i) => {
    const c = r.customers;
    const useSlot2 = r.address_slot === 2;
    const area = useSlot2 ? (c?.area_2 ?? c?.area ?? "") : (c?.area ?? "");
    const subArea = useSlot2 ? (c?.sub_area_2 ?? "") : (c?.sub_area ?? "");
    const address = useSlot2 ? (c?.address_2 ?? c?.address ?? "") : (c?.address ?? "");
    const mapsLink = useSlot2 ? (c?.google_maps_link_2 ?? c?.google_maps_link ?? "") : (c?.google_maps_link ?? "");
    text += `${i + 1}. ${c?.name ?? "?"}\n`;
    text += `${area}${subArea ? `\n${subArea}` : ""}\n`;
    text += `${address}\n`;
    if (mapsLink) text += `${mapsLink}\n`;
    text += `${r.portions} porsi\n\n`;
  });
  return text.trim();
}

function UploadButton({
  uploadState,
  onUpload,
}: {
  uploadState: "idle" | "uploading" | "done" | "error";
  onUpload: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <td className="w-10 min-w-[2.5rem] px-2 py-2 text-right">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="ghost"
        onClick={() => inputRef.current?.click()}
        disabled={uploadState === "uploading"}
        className="h-7 w-7 shrink-0 p-0 text-gray-400 hover:text-gray-600 disabled:opacity-40"
        title="Upload delivery proof"
      >
        {uploadState === "uploading" && <span className="text-[10px] text-gray-400">...</span>}
        {uploadState === "done" && <span className="text-[11px] text-green-500">✓</span>}
        {uploadState === "error" && <span className="text-[11px] text-red-500">!</span>}
        {uploadState === "idle" && (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 0 2-2l2-2h8l2 2h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
        )}
      </Button>
    </td>
  );
}

function SortableDeliveryRow({
  row,
  position,
  subs,
  onUpdateSkip,
  onUpdatePortions,
  onUpdateSub,
  onUpdateAddressSlot,
  onDelete,
  uploadState,
  onUploadProof,
}: {
  row: DeliveryRow;
  position: number;
  subs: Sub[];
  onUpdateSkip: (customerId: string, mealType: "lunch" | "dinner", skip: boolean) => void;
  onUpdatePortions: (customerId: string, mealType: "lunch" | "dinner", portions: number) => void;
  onUpdateSub: (customerId: string, mealType: "lunch" | "dinner", subId: string | null) => void;
  onUpdateAddressSlot: (customerId: string, mealType: "lunch" | "dinner", slot: number) => void;
  onDelete: () => void;
  uploadState: "idle" | "uploading" | "done" | "error";
  onUploadProof: (file: File) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.customer_id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <tr ref={setNodeRef} style={style} className={row.skip ? "opacity-40" : ""}>
      <td className="px-2 py-2 text-gray-300 cursor-grab touch-none" {...attributes} {...listeners}>
        <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true">
          <circle cx="4" cy="4" r="1.5" /><circle cx="8" cy="4" r="1.5" />
          <circle cx="4" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" />
          <circle cx="4" cy="12" r="1.5" /><circle cx="8" cy="12" r="1.5" />
        </svg>
      </td>
      <td className="px-2 py-2 text-gray-300 text-xs w-5 tabular-nums">{position}</td>
      <td className="px-2 py-2">
        <Checkbox
          checked={!row.skip}
          onCheckedChange={(checked) => onUpdateSkip(row.customer_id, row.meal_type, !checked)}
        />
      </td>
      <td className="px-2 py-2">
        <div className="font-medium text-gray-900 text-sm flex items-center gap-1">
          <span>{row.customers?.name ?? row.customer_id.slice(0, 8)}</span>
          {row.orders?.size === "m" && <span className="text-xs bg-orange-100 text-orange-700 px-1 rounded">M</span>}
          <Button
            type="button"
            variant="ghost"
            aria-label="Delete delivery"
            onClick={onDelete}
            className="ml-auto text-gray-300 hover:text-red-600 h-auto w-auto p-0.5 text-xs"
          >
            ✕
          </Button>
        </div>
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <span>
            {row.address_slot === 2
              ? `${row.customers?.area_2 ?? ""}${row.customers?.sub_area_2 ? ` · ${row.customers.sub_area_2}` : ""}`
              : `${row.customers?.area ?? ""}${row.customers?.sub_area ? ` · ${row.customers.sub_area}` : ""}`}
          </span>
          {row.customers?.address_2 && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => onUpdateAddressSlot(row.customer_id, row.meal_type, row.address_slot === 2 ? 1 : 2)}
              className="ml-1 text-[10px] font-medium bg-gray-100 hover:bg-gray-200 text-gray-600 px-1 rounded h-auto py-0"
            >
              {row.address_slot === 2 ? "A2" : "A1"}
            </Button>
          )}
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-1">
          <Button type="button" variant="outline" onClick={() => onUpdatePortions(row.customer_id, row.meal_type, Math.max(1, row.portions - 1))} className="w-5 h-5 rounded border text-xs p-0">-</Button>
          <span className="w-6 text-center text-sm">{row.portions}</span>
          <Button type="button" variant="outline" onClick={() => onUpdatePortions(row.customer_id, row.meal_type, row.portions + 1)} className="w-5 h-5 rounded border text-xs p-0">+</Button>
        </div>
      </td>
      <td className="px-2 py-2">
        <Select
          value={row.subcontractor_id ?? NO_SUB}
          onValueChange={(v) => onUpdateSub(row.customer_id, row.meal_type, v === NO_SUB ? null : v)}
        >
          <SelectTrigger className="h-auto w-12 rounded border-gray-200 px-1 py-0.5 text-xs sm:w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_SUB}>—</SelectItem>
            {subs.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </td>
      <UploadButton uploadState={uploadState} onUpload={onUploadProof} />
    </tr>
  );
}

export default function DeliveriesClient() {
  const [tab, setTab] = useState<"sheet" | "proofs">("sheet");
  const [date, setDate] = useState(tomorrow());
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeliveryRow | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [uploadStates, setUploadStates] = useState<Record<string, "idle" | "uploading" | "done" | "error">>({});
  const [showAdd, setShowAdd] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [addCustomer, setAddCustomer] = useState<AddableCustomer | null>(null);
  const [addDropdownOpen, setAddDropdownOpen] = useState(false);
  const [addMeal, setAddMeal] = useState<"lunch" | "dinner">("lunch");
  const [addPortions, setAddPortions] = useState(1);
  const [addSubId, setAddSubId] = useState<string | null>(null);
  const qc = useQueryClient();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const { data: sheetData, isLoading: sheetLoading } = useQuery({
    queryKey: ["daily-sheet", date],
    queryFn: async () => {
      const res = await fetch(`/api/deliveries/daily-sheet?date=${date}`);
      const json = await res.json() as { ok: boolean; data: DeliveryRow[] };
      return json.data;
    },
  });

  const { data: subs } = useQuery({
    queryKey: ["subcontractors"],
    queryFn: async () => {
      const res = await fetch("/api/subcontractors");
      const json = await res.json() as { ok: boolean; data: Sub[] };
      return json.data;
    },
  });

  const { data: addableCustomers } = useQuery({
    queryKey: ["addable-customers"],
    queryFn: async () => {
      const res = await fetch("/api/deliveries/addable-customers");
      const json = await res.json() as { ok: boolean; data: AddableCustomer[] };
      return json.data;
    },
    enabled: showAdd,
  });

  const { data: proofs } = useQuery({
    queryKey: ["delivery-proofs", date],
    queryFn: async () => {
      const res = await fetch(`/api/deliveries/proofs?date=${date}`);
      const json = await res.json() as { ok: boolean; data: Proof[] };
      return json.data;
    },
    refetchInterval: tab === "proofs" ? 15000 : false,
  });

  useEffect(() => {
    if (sheetData) {
      setRows(sheetData.map((r) => ({ ...r, skip: r.status === "skipped", address_slot: r.address_slot ?? 1 })));
    }
  }, [sheetData]);

  const generate = useMutation({
    mutationFn: async () => {
      await fetch("/api/deliveries/daily-sheet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date }) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["daily-sheet", date] }); },
  });

  const save = useMutation({
    mutationFn: async () => {
      await fetch("/api/deliveries/daily-sheet", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, rows }),
      });
    },
    onSuccess: () => { setShowConfirm(false); qc.invalidateQueries({ queryKey: ["daily-sheet", date] }); },
  });

  const reorder = useMutation({
    mutationFn: async (updates: { id: string; delivery_position: number }[]) => {
      await fetch("/api/customers/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
    },
  });

  const sendProof = useMutation({
    mutationFn: async ({ id, customer_id }: { id: string; customer_id: string }) => {
      await fetch("/api/deliveries/proofs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "send", customer_id }) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["delivery-proofs", date] }),
  });

  const sendAll = useMutation({
    mutationFn: async (toSend: Proof[]) => {
      for (const p of toSend) {
        if (p.matched_customer_id) {
          await fetch("/api/deliveries/proofs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id, action: "send", customer_id: p.matched_customer_id }) });
        }
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["delivery-proofs", date] }),
  });

  const unmatchProof = useMutation({
    mutationFn: async (id: string) => {
      await fetch("/api/deliveries/proofs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "unmatch" }) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["delivery-proofs", date] }),
  });

  const deleteRow = useMutation({
    mutationFn: async (row: DeliveryRow) => {
      // Unsaved local row (no DB id) — just drop from state, no fetch.
      if (!row.id) return;
      const res = await fetch("/api/deliveries/daily-sheet", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Gagal menghapus");
    },
    onSuccess: (_data, row) => {
      setRows((prev) => prev.filter((r) => !(r.customer_id === row.customer_id && r.meal_type === row.meal_type)));
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["daily-sheet", date] });
    },
  });

  function updateRow(customerId: string, mealType: "lunch" | "dinner", field: keyof DeliveryRow, value: unknown) {
    setRows((prev) => prev.map((r) =>
      r.customer_id === customerId && r.meal_type === mealType ? { ...r, [field]: value } : r,
    ));
  }

  function defaultPortionsFor(c: AddableCustomer | null, meal: "lunch" | "dinner"): number {
    const o = c?.active_order;
    if (!o) return 1;
    const slot = meal === "lunch" ? o.portions_lunch : o.portions_dinner;
    return (slot ?? 0) > 0 ? (slot as number) : o.portions_per_delivery || 1;
  }

  function selectAddCustomer(c: AddableCustomer) {
    setAddCustomer(c);
    setAddSearch(c.name ?? c.phone_number);
    setAddDropdownOpen(false);
    setAddPortions(defaultPortionsFor(c, addMeal));
    setAddSubId(c.subcontractor_id);
  }

  function resetAdd() {
    setShowAdd(false);
    setAddSearch("");
    setAddCustomer(null);
    setAddDropdownOpen(false);
    setAddMeal("lunch");
    setAddPortions(1);
    setAddSubId(null);
  }

  function confirmAddRow() {
    if (!addCustomer) return;
    if (rows.some((r) => r.customer_id === addCustomer.id && r.meal_type === addMeal)) {
      alert(`${addCustomer.name ?? addCustomer.phone_number} sudah ada di daftar ${addMeal} untuk tanggal ini.`);
      return;
    }
    const { active_order, ...cust } = addCustomer;
    setRows((prev) => [
      ...prev,
      {
        customer_id: addCustomer.id,
        order_id: active_order.id,
        meal_type: addMeal,
        portions: addPortions,
        subcontractor_id: addSubId,
        notes: null,
        status: "scheduled",
        skip: false,
        address_slot: 1,
        customers: cust,
      },
    ]);
    resetAdd();
  }

  function handleDragEnd(event: DragEndEvent, route: number) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const sortedIds = getRouteSortedIds(rows, route);
    const oldIndex = sortedIds.indexOf(active.id as string);
    const newIndex = sortedIds.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    const reorderedIds = arrayMove(sortedIds, oldIndex, newIndex);
    const posMap = new Map(reorderedIds.map((id, i) => [id, i]));
    setRows((prev) =>
      prev.map((r) => {
        if (!r.customers || r.customers.delivery_route !== route) return r;
        const newPos = posMap.get(r.customer_id);
        if (newPos === undefined) return r;
        return { ...r, customers: { ...r.customers, delivery_position: newPos } };
      }),
    );
    reorder.mutate(reorderedIds.map((id, i) => ({ id, delivery_position: i })));
  }

  const lunchRows = rows.filter((r) => r.meal_type === "lunch");
  const dinnerRows = rows.filter((r) => r.meal_type === "dinner");
  const uniqueSubs = [...new Set(rows.filter((r) => r.subcontractor_id).map((r) => r.subcontractor_id as string))];

  const autoSent = (proofs ?? []).filter((p) => p.status === "auto_sent");
  const adminUploaded = (proofs ?? []).filter((p) => p.status === "admin_uploaded");
  const manuallySent = (proofs ?? []).filter((p) => p.status === "manually_sent");
  const needsReview = (proofs ?? []).filter((p) => p.status === "needs_review");
  const unmatched = (proofs ?? []).filter((p) => p.status === "unmatched");

  const proofCustomerIds = new Set((proofs ?? []).map((p) => p.matched_customer_id));

  const activeSubs = (subs ?? []).filter((s: Sub & { is_active?: boolean }) => s.is_active !== false);

  async function handleUploadProof(customerId: string, mealType: "lunch" | "dinner", subcontractorId: string | null, file: File) {
    const key = `${customerId}-${mealType}`;
    setUploadStates((prev) => ({ ...prev, [key]: "uploading" }));
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("customer_id", customerId);
      if (subcontractorId) fd.append("subcontractor_id", subcontractorId);
      fd.append("date", date);
      const res = await fetch("/api/deliveries/proofs", { method: "POST", body: fd });
      const json = await res.json() as { ok: boolean };
      setUploadStates((prev) => ({ ...prev, [key]: json.ok ? "done" : "error" }));
      if (json.ok) qc.invalidateQueries({ queryKey: ["delivery-proofs", date] });
    } catch {
      setUploadStates((prev) => ({ ...prev, [key]: "error" }));
    }
  }

  function copyText(key: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    });
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <h1 className="text-xl font-semibold text-gray-900">Deliveries</h1>
        <div className="flex border border-gray-200 rounded-lg overflow-hidden text-sm">
          <Button type="button" variant="ghost" onClick={() => setTab("sheet")} className={`px-4 py-1.5 rounded-none h-auto ${tab === "sheet" ? "bg-gray-900 text-white hover:bg-gray-900 hover:text-white" : "text-gray-600 hover:bg-gray-50"}`}>Daily Sheet</Button>
          <Button type="button" variant="ghost" onClick={() => setTab("proofs")} className={`px-4 py-1.5 rounded-none h-auto ${tab === "proofs" ? "bg-gray-900 text-white hover:bg-gray-900 hover:text-white" : "text-gray-600 hover:bg-gray-50"}`}>Proof of Delivery</Button>
        </div>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border-gray-200 rounded-lg px-3 py-1.5 text-sm ml-auto h-auto w-auto" />
      </div>

      {tab === "sheet" && (
        <div>
          {isPastDeadline(date) && (
            <div className="mb-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
              ⚠️ Deadline sudah lewat. Perubahan ini harus dikomunikasikan langsung ke subcontractor.
            </div>
          )}

          {/* Summary */}
          <div className="flex gap-4 mb-4">
            <div className="bg-white border border-gray-100 rounded-lg px-4 py-3 text-sm">
              <div className="text-gray-500 text-xs">Total Lunch</div>
              <div className="font-semibold text-gray-900">{lunchRows.filter((r) => !r.skip).reduce((s, r) => s + r.portions, 0)} porsi</div>
            </div>
            <div className="bg-white border border-gray-100 rounded-lg px-4 py-3 text-sm">
              <div className="text-gray-500 text-xs">Total Dinner</div>
              <div className="font-semibold text-gray-900">{dinnerRows.filter((r) => !r.skip).reduce((s, r) => s + r.portions, 0)} porsi</div>
            </div>
            <div className="flex gap-2 ml-auto">
              <Button type="button" variant="outline" onClick={() => rows.length === 0 ? generate.mutate() : qc.invalidateQueries({ queryKey: ["daily-sheet", date] })} disabled={generate.isPending} className="px-4 py-2 border-gray-200 text-gray-900 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-40 h-auto">
                {generate.isPending ? "Refreshing..." : "Refresh"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowAdd(true)} className="px-4 py-2 border-gray-200 text-gray-900 text-sm rounded-lg hover:bg-gray-50 h-auto">+ Add customer</Button>
              <Button type="button" onClick={() => setShowConfirm(true)} disabled={rows.length === 0} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-40 h-auto">Save</Button>
            </div>
          </div>

          {sheetLoading ? (
            <div className="text-gray-400 text-sm">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="text-gray-400 text-sm text-center py-12">No deliveries for this date. Click Refresh to load from active orders.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(["lunch", "dinner"] as const).map((meal) => (
                <div key={meal}>
                  <h2 className="font-medium text-gray-700 text-sm mb-2 uppercase tracking-wide">{meal}</h2>
                  <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-gray-400 text-xs">
                        <tr>
                          <th className="px-2 py-2 w-6" />
                          <th className="px-2 py-2 w-5" />
                          <th className="px-2 py-2 text-left w-6">✓</th>
                          <th className="px-2 py-2 text-left">Customer</th>
                          <th className="px-2 py-2 text-left">Portions</th>
                          <th className="px-2 py-2 text-left">Dapur</th>
                          <th className="px-2 py-2 w-10 min-w-[2.5rem]" />
                        </tr>
                      </thead>
                      {([1, 2] as const).map((route) => {
                        const routeRows = getRouteMealRows(rows, route, meal);
                        if (!routeRows.length) return null;
                        const sortedIds = getRouteSortedIds(rows, route);
                        return (
                          <Fragment key={route}>
                            <tbody>
                              <tr className="bg-gray-50 border-t border-gray-100">
                                <td colSpan={7} className="px-3 py-1.5 text-xs font-medium text-gray-500">
                                  {ROUTE_LABELS[route]}
                                </td>
                              </tr>
                            </tbody>
                            <DndContext
                              sensors={sensors}
                              collisionDetection={closestCenter}
                              onDragEnd={(e) => handleDragEnd(e, route)}
                            >
                              <SortableContext items={sortedIds} strategy={verticalListSortingStrategy}>
                                <tbody className="divide-y divide-gray-50">
                                  {routeRows.map((r, i) => (
                                    <SortableDeliveryRow
                                      key={r.customer_id}
                                      row={r}
                                      position={i + 1}
                                      subs={activeSubs}
                                      onUpdateSkip={(cid, mt, skip) => updateRow(cid, mt, "skip", skip)}
                                      onUpdatePortions={(cid, mt, portions) => updateRow(cid, mt, "portions", portions)}
                                      onUpdateSub={(cid, mt, subId) => updateRow(cid, mt, "subcontractor_id", subId)}
                                      onUpdateAddressSlot={(cid, mt, slot) => updateRow(cid, mt, "address_slot", slot)}
                                      onDelete={() => setDeleteTarget(r)}
                                      uploadState={uploadStates[`${r.customer_id}-${r.meal_type}`] ?? (proofCustomerIds.has(r.customer_id) ? "done" : "idle")}
                                      onUploadProof={(file) => handleUploadProof(r.customer_id, r.meal_type, r.subcontractor_id, file)}
                                    />
                                  ))}
                                </tbody>
                              </SortableContext>
                            </DndContext>
                          </Fragment>
                        );
                      })}
                      {/* Unassigned rows (no delivery_route) */}
                      {getUnassignedMealRows(rows, meal).length > 0 && (
                        <>
                          <tbody>
                            <tr className="bg-gray-50 border-t border-gray-100">
                              <td colSpan={7} className="px-3 py-1.5 text-xs font-medium text-gray-400 italic">
                                Unassigned route
                              </td>
                            </tr>
                          </tbody>
                          <tbody className="divide-y divide-gray-50">
                            {getUnassignedMealRows(rows, meal).map((r) => (
                              <tr key={r.customer_id} className={r.skip ? "opacity-40" : ""}>
                                <td className="px-2 py-2 w-6" />
                                <td className="px-2 py-2 w-5" />
                                <td className="px-2 py-2">
                                  <Checkbox checked={!r.skip} onCheckedChange={(checked) => updateRow(r.customer_id, meal, "skip", !checked)} />
                                </td>
                                <td className="px-2 py-2">
                                  <div className="font-medium text-gray-900 text-sm flex items-center gap-1">
                                    <span>{r.customers?.name ?? r.customer_id.slice(0, 8)}</span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      aria-label="Delete delivery"
                                      onClick={() => setDeleteTarget(r)}
                                      className="ml-auto text-gray-300 hover:text-red-600 h-auto w-auto p-0.5 text-xs"
                                    >
                                      ✕
                                    </Button>
                                  </div>
                                  <div className="flex items-center gap-1 text-xs text-gray-400">
                                    <span>
                                      {r.address_slot === 2
                                        ? `${r.customers?.area_2 ?? ""}${r.customers?.sub_area_2 ? ` · ${r.customers.sub_area_2}` : ""}`
                                        : `${r.customers?.area ?? ""}${r.customers?.sub_area ? ` · ${r.customers.sub_area}` : ""}`}
                                    </span>
                                    {r.customers?.address_2 && (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        onClick={() => updateRow(r.customer_id, meal, "address_slot", r.address_slot === 2 ? 1 : 2)}
                                        className="ml-1 text-[10px] font-medium bg-gray-100 hover:bg-gray-200 text-gray-600 px-1 rounded h-auto py-0"
                                      >
                                        {r.address_slot === 2 ? "A2" : "A1"}
                                      </Button>
                                    )}
                                  </div>
                                </td>
                                <td className="px-2 py-2">
                                  <div className="flex items-center gap-1">
                                    <Button type="button" variant="outline" onClick={() => updateRow(r.customer_id, meal, "portions", Math.max(1, r.portions - 1))} className="w-5 h-5 rounded border text-xs p-0">-</Button>
                                    <span className="w-6 text-center text-sm">{r.portions}</span>
                                    <Button type="button" variant="outline" onClick={() => updateRow(r.customer_id, meal, "portions", r.portions + 1)} className="w-5 h-5 rounded border text-xs p-0">+</Button>
                                  </div>
                                </td>
                                <td className="px-2 py-2">
                                  <Select
                                    value={r.subcontractor_id ?? NO_SUB}
                                    onValueChange={(v) => updateRow(r.customer_id, meal, "subcontractor_id", v === NO_SUB ? null : v)}
                                  >
                                    <SelectTrigger className="h-auto w-12 rounded border-gray-200 px-1 py-0.5 text-xs sm:w-auto">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value={NO_SUB}>—</SelectItem>
                                      {activeSubs.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                                    </SelectContent>
                                  </Select>
                                </td>
                                <UploadButton
                                  uploadState={uploadStates[`${r.customer_id}-${meal}`] ?? (proofCustomerIds.has(r.customer_id) ? "done" : "idle")}
                                  onUpload={(file) => handleUploadProof(r.customer_id, meal, r.subcontractor_id, file)}
                                />
                              </tr>
                            ))}
                          </tbody>
                        </>
                      )}
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Copy buttons */}
          {rows.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {([1, 2] as const).flatMap((route) =>
                (["lunch", "dinner"] as const).map((meal) => {
                  const key = `route-${route}-${meal}`;
                  const hasRows = rows.some((r) => r.customers?.delivery_route === route && r.meal_type === meal && !r.skip);
                  if (!hasRows) return null;
                  return (
                    <Button
                      key={key}
                      type="button"
                      variant="outline"
                      onClick={() => copyText(key, buildRouteMealSummary(rows, route, meal, date))}
                      className="px-3 py-1.5 border-blue-200 bg-blue-50 text-blue-700 text-sm rounded-lg hover:bg-blue-100 h-auto"
                    >
                      {copiedKey === key ? "Copied!" : `Copy Route ${route} ${meal === "lunch" ? "Lunch" : "Dinner"}`}
                    </Button>
                  );
                })
              )}
              {uniqueSubs.map((subId) => {
                const sub = (subs ?? []).find((s: Sub) => s.id === subId);
                const key = `sub-${subId}`;
                return (
                  <Button
                    key={key}
                    type="button"
                    variant="outline"
                    onClick={() => copyText(key, buildSubcontractorSummary(rows, subs ?? [], subId, date))}
                    className="px-3 py-1.5 border-gray-200 text-sm rounded-lg hover:bg-gray-50 h-auto"
                  >
                    {copiedKey === key ? "Copied!" : `Copy for ${sub?.name ?? subId}`}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "proofs" && (
        <div className="space-y-6">
          {adminUploaded.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-medium text-gray-700 text-sm">Ready to send ({adminUploaded.length})</h2>
                <Button
                  type="button"
                  onClick={() => sendAll.mutate(adminUploaded)}
                  disabled={sendAll.isPending || adminUploaded.every((p) => !p.matched_customer_id)}
                  className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg disabled:opacity-40 h-auto"
                >
                  {sendAll.isPending ? "Sending..." : "Send All"}
                </Button>
              </div>
              <div className="space-y-2">
                {adminUploaded.map((p) => (
                  <div key={p.id} className="bg-white border border-gray-100 rounded-xl p-3 flex items-center gap-4">
                    {/* biome-ignore lint/performance/noImgElement: signed Supabase URL — next/image impractical */}
                    {p.signed_url && <img src={p.signed_url} alt="proof" className="w-16 h-16 object-cover rounded-lg flex-shrink-0" />}
                    <div className="flex-1 text-sm text-gray-700">{p.customers?.name ?? p.matched_customer_id?.slice(0, 8) ?? "Unknown"}</div>
                    <Button
                      type="button"
                      onClick={() => p.matched_customer_id && sendProof.mutate({ id: p.id, customer_id: p.matched_customer_id })}
                      disabled={!p.matched_customer_id || sendProof.isPending}
                      className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg disabled:opacity-40 h-auto"
                    >
                      Send
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <h2 className="font-medium text-gray-700 text-sm mb-2">Manually sent ({manuallySent.length})</h2>
            {manuallySent.length === 0 ? <p className="text-gray-400 text-sm">None today.</p> : (
              <div className="grid grid-cols-3 gap-3">
                {manuallySent.map((p) => (
                  <div key={p.id} className="bg-white border border-gray-100 rounded-xl p-3">
                    {/* biome-ignore lint/performance/noImgElement: signed Supabase URL — next/image impractical */}
                    {p.signed_url && <img src={p.signed_url} alt="proof" className="w-full h-32 object-cover rounded-lg mb-2" />}
                    <div className="text-xs text-gray-600">{p.customers?.name ?? "Unknown"}</div>
                    <div className="text-xs text-gray-400">{p.sent_to_customer_at ? new Date(p.sent_to_customer_at).toLocaleTimeString("id-ID") : ""}</div>
                    {p.sent_by && <div className="text-xs text-gray-400">by {p.sent_by}</div>}
                    {p.matched_customer_id && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => sendProof.mutate({ id: p.id, customer_id: p.matched_customer_id! })}
                        disabled={sendProof.isPending}
                        className="mt-2 w-full px-2 py-1 text-xs border-gray-200 text-gray-500 rounded-lg h-auto"
                      >
                        Resend
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h2 className="font-medium text-gray-700 text-sm mb-2">Auto-matched & sent ({autoSent.length})</h2>
            {autoSent.length === 0 ? <p className="text-gray-400 text-sm">None today.</p> : (
              <div className="grid grid-cols-3 gap-3">
                {autoSent.map((p) => (
                  <div key={p.id} className="bg-white border border-gray-100 rounded-xl p-3">
                    {/* biome-ignore lint/performance/noImgElement: signed Supabase URL — next/image impractical */}
                    {p.signed_url && <img src={p.signed_url} alt="proof" className="w-full h-32 object-cover rounded-lg mb-2" />}
                    <div className="text-xs text-gray-600">{p.customers?.name ?? "Unknown"}</div>
                    <div className="text-xs text-gray-400">Confidence: {p.match_confidence ? `${Math.round(p.match_confidence * 100)}%` : "—"}</div>
                    <div className="text-xs text-gray-400">{p.sent_to_customer_at ? new Date(p.sent_to_customer_at).toLocaleTimeString("id-ID") : ""}</div>
                    {p.matched_customer_id && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => sendProof.mutate({ id: p.id, customer_id: p.matched_customer_id! })}
                        disabled={sendProof.isPending}
                        className="mt-2 w-full px-2 py-1 text-xs border-gray-200 text-gray-500 rounded-lg h-auto"
                      >
                        Resend
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h2 className="font-medium text-gray-700 text-sm mb-2">Needs review ({needsReview.length})</h2>
            {needsReview.length === 0 ? <p className="text-gray-400 text-sm">None pending.</p> : (
              <div className="space-y-3">
                {needsReview.map((p) => (
                  <ReviewProofCard key={p.id} proof={p} date={date} onSend={(customer_id) => sendProof.mutate({ id: p.id, customer_id })} onUnmatch={() => unmatchProof.mutate(p.id)} />
                ))}
              </div>
            )}
          </div>

          <div>
            <h2 className="font-medium text-gray-700 text-sm mb-2">Unmatched ({unmatched.length})</h2>
            {unmatched.length === 0 ? <p className="text-gray-400 text-sm">None.</p> : (
              <div className="grid grid-cols-3 gap-3">
                {unmatched.map((p) => (
                  <div key={p.id} className="bg-white border border-gray-100 rounded-xl p-3 opacity-60">
                    {/* biome-ignore lint/performance/noImgElement: signed Supabase URL — next/image impractical */}
                    {p.signed_url && <img src={p.signed_url} alt="proof" className="w-full h-32 object-cover rounded-lg mb-2" />}
                    <div className="text-xs text-gray-500">{p.caption ?? "No caption"}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showConfirm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 space-y-4">
            <h2 className="font-semibold text-gray-900">Simpan pengiriman untuk {date}?</h2>
            <p className="text-sm text-gray-500">Ini akan mengurangi kuota pelanggan.</p>
            <div className="flex gap-2">
              <Button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-40 h-auto">{save.isPending ? "Saving..." : "Simpan"}</Button>
              <Button type="button" variant="outline" onClick={() => setShowConfirm(false)} className="flex-1 py-2 border-gray-200 text-sm rounded-lg h-auto">Batal</Button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 space-y-4">
            <h2 className="font-semibold text-gray-900">Hapus pengiriman?</h2>
            <p className="text-sm text-gray-500">
              Hapus {deleteTarget.meal_type === "lunch" ? "makan siang" : "makan malam"} untuk{" "}
              <span className="font-medium">{deleteTarget.customers?.name ?? "pelanggan ini"}</span> pada {date}.
              {deleteTarget.id ? " Baris ini akan dihapus permanen dari sheet." : " Baris ini belum disimpan."}
            </p>
            {deleteRow.isError && <p className="text-sm text-red-600">{(deleteRow.error as Error).message}</p>}
            <div className="flex gap-2">
              <Button type="button" onClick={() => deleteRow.mutate(deleteTarget)} disabled={deleteRow.isPending} className="flex-1 py-2 bg-red-600 text-white text-sm rounded-lg disabled:opacity-40 h-auto">{deleteRow.isPending ? "Menghapus..." : "Hapus"}</Button>
              <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteRow.isPending} className="flex-1 py-2 border-gray-200 text-sm rounded-lg h-auto">Batal</Button>
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Tambah pelanggan ke {date}</h2>
              <Button type="button" variant="ghost" onClick={resetAdd} className="text-gray-400 hover:text-gray-600 text-xl leading-none h-auto w-auto p-0">&times;</Button>
            </div>

            {/* Customer combobox */}
            <div className="relative">
              <span className="block text-sm font-medium text-gray-700 mb-1">Pelanggan</span>
              <Input
                type="text"
                value={addSearch}
                placeholder="Cari nama atau nomor..."
                onChange={(e) => { setAddSearch(e.target.value); setAddCustomer(null); setAddDropdownOpen(true); }}
                onFocus={() => setAddDropdownOpen(true)}
                className="w-full border-gray-200 rounded-lg px-3 py-2 text-sm h-auto"
              />
              {addDropdownOpen && (
                <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-52 overflow-y-auto">
                  {(addSearch.trim() === ""
                    ? (addableCustomers ?? [])
                    : (addableCustomers ?? []).filter((c) => {
                        const q = addSearch.toLowerCase();
                        return (c.name ?? "").toLowerCase().includes(q) || c.phone_number.includes(q);
                      })
                  ).slice(0, 50).map((c) => (
                    <li
                      key={c.id}
                      onMouseDown={(e) => { e.preventDefault(); selectAddCustomer(c); }}
                      className="px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 flex justify-between"
                    >
                      <span className="text-gray-900">{c.name ?? c.phone_number}</span>
                      <span className="text-gray-400 text-xs">{c.area}</span>
                    </li>
                  ))}
                  {(addableCustomers ?? []).length === 0 && (
                    <li className="px-3 py-2 text-sm text-gray-400">Memuat...</li>
                  )}
                </ul>
              )}
            </div>

            {/* Meal type */}
            <div>
              <span className="block text-sm font-medium text-gray-700 mb-1">Waktu makan</span>
              <Select
                value={addMeal}
                onValueChange={(v) => { const m = v as "lunch" | "dinner"; setAddMeal(m); setAddPortions(defaultPortionsFor(addCustomer, m)); }}
              >
                <SelectTrigger className="w-full border-gray-200 rounded-lg text-sm h-auto"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lunch">Lunch</SelectItem>
                  <SelectItem value="dinner">Dinner</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Portions */}
            <div>
              <span className="block text-sm font-medium text-gray-700 mb-1">Porsi</span>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => setAddPortions((p) => Math.max(1, p - 1))} className="w-7 h-7 rounded border text-sm p-0">-</Button>
                <span className="w-8 text-center text-sm">{addPortions}</span>
                <Button type="button" variant="outline" onClick={() => setAddPortions((p) => p + 1)} className="w-7 h-7 rounded border text-sm p-0">+</Button>
              </div>
            </div>

            {/* Subcontractor */}
            <div>
              <span className="block text-sm font-medium text-gray-700 mb-1">Dapur</span>
              <Select value={addSubId ?? NO_SUB} onValueChange={(v) => setAddSubId(v === NO_SUB ? null : v)}>
                <SelectTrigger className="w-full border-gray-200 rounded-lg text-sm h-auto"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SUB}>—</SelectItem>
                  {activeSubs.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex gap-2 pt-1">
              <Button type="button" onClick={confirmAddRow} disabled={!addCustomer} className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-40 h-auto">Tambah</Button>
              <Button type="button" variant="outline" onClick={resetAdd} className="flex-1 py-2 border-gray-200 text-sm rounded-lg h-auto">Batal</Button>
            </div>
            <p className="text-xs text-gray-400">Klik Save setelah menambah untuk menyimpan ke sheet.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewProofCard({ proof, date, onSend, onUnmatch }: { proof: Proof; date: string; onSend: (customerId: string) => void; onUnmatch: () => void }) {
  const { data: sheetData } = useQuery({
    queryKey: ["daily-sheet", date],
    queryFn: async () => {
      const res = await fetch(`/api/deliveries/daily-sheet?date=${date}`);
      const json = await res.json() as { ok: boolean; data: Array<{ customer_id: string; customers?: { name: string | null } }> };
      return json.data;
    },
  });

  const [selectedCustomer, setSelectedCustomer] = useState(proof.matched_customer_id ?? "");
  const customers = [...new Map((sheetData ?? []).map((r) => [r.customer_id, r.customers?.name ?? r.customer_id.slice(0, 8)])).entries()];

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-4 flex gap-4">
      {/* biome-ignore lint/performance/noImgElement: signed Supabase URL — next/image impractical */}
      {proof.signed_url && <img src={proof.signed_url} alt="proof" className="w-32 h-32 object-cover rounded-lg flex-shrink-0" />}
      <div className="flex-1 space-y-2">
        <div className="text-xs text-gray-500">From: {proof.subcontractors?.name ?? "Unknown"}</div>
        {proof.caption && <div className="text-sm text-gray-700">"{proof.caption}"</div>}
        {proof.match_confidence !== null && (
          <div className="text-xs text-gray-400">AI confidence: {Math.round((proof.match_confidence ?? 0) * 100)}%</div>
        )}
        <Select value={selectedCustomer || undefined} onValueChange={setSelectedCustomer}>
          <SelectTrigger className="w-full border-gray-200 rounded-lg px-2 py-1.5 text-sm h-auto">
            <SelectValue placeholder="Select customer..." />
          </SelectTrigger>
          <SelectContent>
            {customers.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex gap-2">
          <Button type="button" onClick={() => onSend(selectedCustomer)} disabled={!selectedCustomer} className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg disabled:opacity-40 h-auto">Send</Button>
          <Button type="button" variant="outline" onClick={onUnmatch} className="px-3 py-1.5 border-gray-200 text-xs rounded-lg text-gray-500 h-auto">Can't match</Button>
        </div>
      </div>
    </div>
  );
}
