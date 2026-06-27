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

function buildRouteSummary(rows: DeliveryRow[], route: number, date: string): string {
  const routeRows = rows.filter((r) => r.customers?.delivery_route === route && !r.skip);
  const customerIds = getRouteSortedIds(rows.filter((r) => !r.skip), route);
  const dateStr = new Date(date).toLocaleDateString("id-ID", { day: "numeric", month: "long" });
  let text = `🛵 *Rute ${route} - ${dateStr}*\n`;
  let stop = 1;
  for (const custId of customerIds) {
    const custRows = routeRows.filter((r) => r.customer_id === custId);
    if (!custRows.length) continue;
    const cust = custRows[0].customers;
    const meals = custRows.map((r) => `${r.meal_type === "lunch" ? "makan siang" : "makan malam"} ${r.portions} porsi`).join(" + ");
    text += `${stop}. ${cust?.name ?? "?"} - ${cust?.area ?? ""}${cust?.sub_area ? ` (${cust.sub_area})` : ""} - ${meals}\n`;
    stop++;
  }
  text += `\nTotal stops: ${stop - 1}`;
  return text;
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
    <td className="px-1 py-2">
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
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploadState === "uploading"}
        className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-600 disabled:opacity-40"
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
      </button>
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
        <input
          type="checkbox"
          checked={!row.skip}
          onChange={(e) => onUpdateSkip(row.customer_id, row.meal_type, !e.target.checked)}
        />
      </td>
      <td className="px-2 py-2">
        <div className="font-medium text-gray-900 text-sm">
          {row.customers?.name ?? row.customer_id.slice(0, 8)}
          {row.orders?.size === "m" && <span className="ml-1 text-xs bg-orange-100 text-orange-700 px-1 rounded">M</span>}
        </div>
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <span>
            {row.address_slot === 2
              ? `${row.customers?.area_2 ?? ""}${row.customers?.sub_area_2 ? ` · ${row.customers.sub_area_2}` : ""}`
              : `${row.customers?.area ?? ""}${row.customers?.sub_area ? ` · ${row.customers.sub_area}` : ""}`}
          </span>
          {row.customers?.address_2 && (
            <button
              type="button"
              onClick={() => onUpdateAddressSlot(row.customer_id, row.meal_type, row.address_slot === 2 ? 1 : 2)}
              className="ml-1 text-[10px] font-medium bg-gray-100 hover:bg-gray-200 text-gray-600 px-1 rounded"
            >
              {row.address_slot === 2 ? "A2" : "A1"}
            </button>
          )}
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onUpdatePortions(row.customer_id, row.meal_type, Math.max(1, row.portions - 1))} className="w-5 h-5 rounded border text-xs">-</button>
          <span className="w-6 text-center text-sm">{row.portions}</span>
          <button type="button" onClick={() => onUpdatePortions(row.customer_id, row.meal_type, row.portions + 1)} className="w-5 h-5 rounded border text-xs">+</button>
        </div>
      </td>
      <td className="px-2 py-2">
        <select
          value={row.subcontractor_id ?? ""}
          onChange={(e) => onUpdateSub(row.customer_id, row.meal_type, e.target.value || null)}
          className="text-xs border border-gray-200 rounded px-1 py-0.5 w-14 sm:w-auto"
        >
          <option value="">—</option>
          {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
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
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [uploadStates, setUploadStates] = useState<Record<string, "idle" | "uploading" | "done" | "error">>({});
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

  function updateRow(customerId: string, mealType: "lunch" | "dinner", field: keyof DeliveryRow, value: unknown) {
    setRows((prev) => prev.map((r) =>
      r.customer_id === customerId && r.meal_type === mealType ? { ...r, [field]: value } : r,
    ));
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
          <button type="button" onClick={() => setTab("sheet")} className={`px-4 py-1.5 ${tab === "sheet" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"}`}>Daily Sheet</button>
          <button type="button" onClick={() => setTab("proofs")} className={`px-4 py-1.5 ${tab === "proofs" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"}`}>Proof of Delivery</button>
        </div>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm ml-auto" />
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
              <button type="button" onClick={() => rows.length === 0 ? generate.mutate() : qc.invalidateQueries({ queryKey: ["daily-sheet", date] })} disabled={generate.isPending} className="px-4 py-2 border border-gray-200 text-gray-900 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-40">
                {generate.isPending ? "Refreshing..." : "Refresh"}
              </button>
              <button type="button" onClick={() => setShowConfirm(true)} disabled={rows.length === 0} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-40">Save</button>
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
                          <th className="px-1 py-2 w-8" />
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
                                  <input type="checkbox" checked={!r.skip} onChange={(e) => updateRow(r.customer_id, meal, "skip", !e.target.checked)} />
                                </td>
                                <td className="px-2 py-2">
                                  <div className="font-medium text-gray-900 text-sm">{r.customers?.name ?? r.customer_id.slice(0, 8)}</div>
                                  <div className="flex items-center gap-1 text-xs text-gray-400">
                                    <span>
                                      {r.address_slot === 2
                                        ? `${r.customers?.area_2 ?? ""}${r.customers?.sub_area_2 ? ` · ${r.customers.sub_area_2}` : ""}`
                                        : `${r.customers?.area ?? ""}${r.customers?.sub_area ? ` · ${r.customers.sub_area}` : ""}`}
                                    </span>
                                    {r.customers?.address_2 && (
                                      <button
                                        type="button"
                                        onClick={() => updateRow(r.customer_id, meal, "address_slot", r.address_slot === 2 ? 1 : 2)}
                                        className="ml-1 text-[10px] font-medium bg-gray-100 hover:bg-gray-200 text-gray-600 px-1 rounded"
                                      >
                                        {r.address_slot === 2 ? "A2" : "A1"}
                                      </button>
                                    )}
                                  </div>
                                </td>
                                <td className="px-2 py-2">
                                  <div className="flex items-center gap-1">
                                    <button type="button" onClick={() => updateRow(r.customer_id, meal, "portions", Math.max(1, r.portions - 1))} className="w-5 h-5 rounded border text-xs">-</button>
                                    <span className="w-6 text-center text-sm">{r.portions}</span>
                                    <button type="button" onClick={() => updateRow(r.customer_id, meal, "portions", r.portions + 1)} className="w-5 h-5 rounded border text-xs">+</button>
                                  </div>
                                </td>
                                <td className="px-2 py-2">
                                  <select
                                    value={r.subcontractor_id ?? ""}
                                    onChange={(e) => updateRow(r.customer_id, meal, "subcontractor_id", e.target.value || null)}
                                    className="text-xs border border-gray-200 rounded px-1 py-0.5 w-14 sm:w-auto"
                                  >
                                    <option value="">—</option>
                                    {activeSubs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                  </select>
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
              {([1, 2] as const).map((route) => {
                const key = `route-${route}`;
                const hasRows = rows.some((r) => r.customers?.delivery_route === route && !r.skip);
                if (!hasRows) return null;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => copyText(key, buildRouteSummary(rows, route, date))}
                    className="px-3 py-1.5 border border-blue-200 bg-blue-50 text-blue-700 text-sm rounded-lg hover:bg-blue-100"
                  >
                    {copiedKey === key ? "Copied!" : `Copy Route ${route}`}
                  </button>
                );
              })}
              {uniqueSubs.map((subId) => {
                const sub = (subs ?? []).find((s: Sub) => s.id === subId);
                const key = `sub-${subId}`;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => copyText(key, buildSubcontractorSummary(rows, subs ?? [], subId, date))}
                    className="px-3 py-1.5 border border-gray-200 text-sm rounded-lg hover:bg-gray-50"
                  >
                    {copiedKey === key ? "Copied!" : `Copy for ${sub?.name ?? subId}`}
                  </button>
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
                <button
                  type="button"
                  onClick={() => sendAll.mutate(adminUploaded)}
                  disabled={sendAll.isPending || adminUploaded.every((p) => !p.matched_customer_id)}
                  className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg disabled:opacity-40"
                >
                  {sendAll.isPending ? "Sending..." : "Send All"}
                </button>
              </div>
              <div className="space-y-2">
                {adminUploaded.map((p) => (
                  <div key={p.id} className="bg-white border border-gray-100 rounded-xl p-3 flex items-center gap-4">
                    {p.signed_url && <img src={p.signed_url} alt="proof" className="w-16 h-16 object-cover rounded-lg flex-shrink-0" />}
                    <div className="flex-1 text-sm text-gray-700">{p.customers?.name ?? p.matched_customer_id?.slice(0, 8) ?? "Unknown"}</div>
                    <button
                      type="button"
                      onClick={() => p.matched_customer_id && sendProof.mutate({ id: p.id, customer_id: p.matched_customer_id })}
                      disabled={!p.matched_customer_id || sendProof.isPending}
                      className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg disabled:opacity-40"
                    >
                      Send
                    </button>
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
                    {p.signed_url && <img src={p.signed_url} alt="proof" className="w-full h-32 object-cover rounded-lg mb-2" />}
                    <div className="text-xs text-gray-600">{p.customers?.name ?? "Unknown"}</div>
                    <div className="text-xs text-gray-400">{p.sent_to_customer_at ? new Date(p.sent_to_customer_at).toLocaleTimeString("id-ID") : ""}</div>
                    {p.sent_by && <div className="text-xs text-gray-400">by {p.sent_by}</div>}
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
                    {p.signed_url && <img src={p.signed_url} alt="proof" className="w-full h-32 object-cover rounded-lg mb-2" />}
                    <div className="text-xs text-gray-600">{p.customers?.name ?? "Unknown"}</div>
                    <div className="text-xs text-gray-400">Confidence: {p.match_confidence ? `${Math.round(p.match_confidence * 100)}%` : "—"}</div>
                    <div className="text-xs text-gray-400">{p.sent_to_customer_at ? new Date(p.sent_to_customer_at).toLocaleTimeString("id-ID") : ""}</div>
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
              <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-40">{save.isPending ? "Saving..." : "Simpan"}</button>
              <button type="button" onClick={() => setShowConfirm(false)} className="flex-1 py-2 border border-gray-200 text-sm rounded-lg">Batal</button>
            </div>
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
      {proof.signed_url && <img src={proof.signed_url} alt="proof" className="w-32 h-32 object-cover rounded-lg flex-shrink-0" />}
      <div className="flex-1 space-y-2">
        <div className="text-xs text-gray-500">From: {proof.subcontractors?.name ?? "Unknown"}</div>
        {proof.caption && <div className="text-sm text-gray-700">"{proof.caption}"</div>}
        {proof.match_confidence !== null && (
          <div className="text-xs text-gray-400">AI confidence: {Math.round((proof.match_confidence ?? 0) * 100)}%</div>
        )}
        <select value={selectedCustomer} onChange={(e) => setSelectedCustomer(e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm">
          <option value="">Select customer...</option>
          {customers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div className="flex gap-2">
          <button type="button" onClick={() => onSend(selectedCustomer)} disabled={!selectedCustomer} className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg disabled:opacity-40">Send</button>
          <button type="button" onClick={onUnmatch} className="px-3 py-1.5 border border-gray-200 text-xs rounded-lg text-gray-500">Can't match</button>
        </div>
      </div>
    </div>
  );
}
