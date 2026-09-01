"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import NewOrderModal from "./new-order-modal";

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
  packageSize: number;
  totalDrawn: number;
  remaining: number;
  remainingToday: number;
};

interface Order {
  id: string;
  customer_id: string;
  package_size: number;
  // Both counted from the delivery rows by GET /api/orders. `remaining_today`
  // is what the customer means by sisa kuota (bought, not yet eaten);
  // `unbooked` is how many more dates they can still ask for.
  remaining_today: number;
  unbooked: number;
  total_price: number;
  status: string;
  start_date: string;
  area: string;
  size: string;
  created_at: string;
  subcontractor_id: string | null;
  end_date: string | null;
  price_per_portion: number;
  addon_cost_per_portion: number | null;
  paid_at: string | null;
  portions_lunch: number | null;
  portions_dinner: number | null;
  portions_per_delivery: number;
  lunch_address_slot: number;
  dinner_address_slot: number;
  customers?: {
    name: string | null;
    phone_number: string;
    area: string | null;
  };
}

const STATUS_LABELS: Record<string, string> = {
  pending_payment: "Pending Payment",
  payment_proof_received: "Proof Received",
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  cancelled_unpaid: "Cancelled (Unpaid)",
  cancelled_by_customer: "Cancelled",
  cancelled_by_admin: "Cancelled (Admin)",
  refunded: "Refunded",
};

const STATUS_COLORS: Record<string, string> = {
  pending_payment: "bg-amber-100 text-amber-700",
  payment_proof_received: "bg-blue-100 text-blue-700",
  active: "bg-green-100 text-green-700",
  paused: "bg-gray-100 text-gray-600",
  completed: "bg-gray-100 text-gray-500",
};

const PENDING_STATUSES = ["pending_payment", "payment_proof_received"];

type EditForm = {
  subcontractor_id: string;
  end_date: string;
  size: string;
  lunch_address_slot: number;
  dinner_address_slot: number;
  portions_lunch: string;
  portions_dinner: string;
  portions_per_delivery: string;
  addon_cost_per_portion: string;
  amount_paid: string;
  start_date: string;
};

export default function OrdersClient() {
  // A link can open this page on one customer's orders — /tasks points here
  // when a task is about a specific order. `status=` (empty) means every status,
  // since the order in question is often not an active one.
  const params = useSearchParams();
  const initialStatus = params.get("status");
  const initialSearch = params.get("search") ?? "";
  const [statusFilter, setStatusFilter] = useState(
    initialStatus === null ? "active" : initialStatus,
  );
  const [search, setSearch] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [selected, setSelected] = useState<Order | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [sortKey, setSortKey] = useState<"start_date" | "created_at">(
    "start_date",
  );
  const qc = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: ledger, isLoading: ledgerLoading } = useQuery({
    queryKey: ["order-ledger", selected?.id],
    enabled: !!selected?.id,
    queryFn: async () => {
      const res = await fetch(`/api/orders/${selected?.id}/ledger`);
      const json = (await res.json()) as { ok: boolean; data: LedgerData };
      return json.data;
    },
  });

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

  async function patchSize(id: string, newSize: "s" | "m") {
    await fetch("/api/orders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "update_size", size: newSize }),
    });
    qc.invalidateQueries({ queryKey: ["orders"] });
  }

  function openDetail(o: Order) {
    setSelected(o);
    setEditForm({
      subcontractor_id: o.subcontractor_id ?? "",
      end_date: o.end_date ?? "",
      size: o.size ?? "s",
      lunch_address_slot: o.lunch_address_slot ?? 1,
      dinner_address_slot: o.dinner_address_slot ?? 1,
      portions_lunch: o.portions_lunch == null ? "" : String(o.portions_lunch),
      portions_dinner:
        o.portions_dinner == null ? "" : String(o.portions_dinner),
      portions_per_delivery:
        o.portions_per_delivery == null ? "" : String(o.portions_per_delivery),
      addon_cost_per_portion: String(o.addon_cost_per_portion ?? 0),
      amount_paid: String(
        (o as unknown as { amount_paid?: number | null }).amount_paid ?? 0,
      ),
      start_date: o.start_date ?? "",
    });
  }

  function closeDetail() {
    setSelected(null);
    setEditForm(null);
    setDeleteConfirmOpen(false);
  }

  async function saveFields() {
    if (!selected || !editForm) return;
    setBusy(true);
    try {
      await fetch("/api/orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selected.id,
          action: "update_fields",
          fields: editForm,
        }),
      });
      qc.invalidateQueries({ queryKey: ["orders"] });
      closeDetail();
    } finally {
      setBusy(false);
    }
  }

  async function markPaid() {
    if (!selected) return;
    setBusy(true);
    try {
      await fetch("/api/orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, action: "mark_paid" }),
      });
      qc.invalidateQueries({ queryKey: ["orders"] });
      closeDetail();
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: string) {
    if (!selected || !status) return;
    setBusy(true);
    try {
      await fetch("/api/orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selected.id,
          action: "update_status",
          status,
        }),
      });
      qc.invalidateQueries({ queryKey: ["orders"] });
      closeDetail();
    } finally {
      setBusy(false);
    }
  }

  async function deleteOrder() {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch("/api/orders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        alert(`Delete failed: ${json.error ?? res.statusText}`);
        return;
      }
      qc.invalidateQueries({ queryKey: ["orders"] });
      closeDetail();
    } finally {
      setBusy(false);
    }
  }

  const { data: orders, isLoading } = useQuery({
    queryKey: ["orders", statusFilter, debouncedSearch],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (debouncedSearch) params.set("search", debouncedSearch);
      const res = await fetch(`/api/orders?${params}`);
      const json = (await res.json()) as { ok: boolean; data: Order[] };
      return json.data;
    },
  });

  const filteredOrders = (orders ?? []).slice().sort((a, b) => {
    const cmp = (a[sortKey] ?? "").localeCompare(b[sortKey] ?? "");
    return sortDir === "asc" ? cmp : -cmp;
  });

  const sortArrow = (key: "start_date" | "created_at") =>
    sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : "";

  function toggleSort(key: "start_date" | "created_at") {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  return (
    <div>
      {showNewOrder && (
        <NewOrderModal
          onClose={() => setShowNewOrder(false)}
          onSuccess={() => qc.invalidateQueries({ queryKey: ["orders"] })}
        />
      )}
      <div className="flex items-center gap-4 mb-4">
        <h1 className="text-xl font-semibold text-gray-900">Orders</h1>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => setShowNewOrder(true)}
          className="ml-auto"
        >
          + Order Baru
        </Button>
        <Input
          type="search"
          placeholder="Cari nama / no HP…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-48 h-8 text-sm"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="pending_payment">Pending Payment</option>
          <option value="payment_proof_received">Proof Received</option>
          <option value="completed">Completed</option>
          <option value="paused">Paused</option>
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
              key={`skel-${i}`}
              className="h-16 bg-gray-100 rounded-xl animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="bg-white border border-gray-100 rounded-xl overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left w-12">No.</th>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Package</th>
                <th className="px-4 py-3 text-left">Size</th>
                <th className="px-4 py-3 text-left">Remaining</th>
                <th className="px-4 py-3 text-left">Total</th>
                <th className="px-4 py-3 text-left">Area</th>
                <th
                  className="px-4 py-3 text-left cursor-pointer select-none hover:text-gray-600"
                  onClick={() => toggleSort("start_date")}
                >
                  Start date {sortArrow("start_date")}
                </th>
                <th
                  className="px-4 py-3 text-left cursor-pointer select-none hover:text-gray-600"
                  onClick={() => toggleSort("created_at")}
                >
                  Created {sortArrow("created_at")}
                </th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filteredOrders.map((o, i) => (
                // biome-ignore lint/a11y/useSemanticElements: interactive table row
                <tr
                  key={o.id}
                  className="hover:bg-gray-50 cursor-pointer"
                  role="button"
                  tabIndex={0}
                  onClick={() => openDetail(o)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openDetail(o);
                    }
                  }}
                >
                  <td className="px-4 py-3 text-gray-400 tabular-nums">
                    {i + 1}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">
                      {o.customers?.name ?? "Unknown"}
                    </div>
                    <div className="text-xs text-gray-400">
                      {o.customers?.phone_number}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-900">
                    {o.package_size} porsi
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={o.size ?? "s"}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation();
                        patchSize(o.id, e.target.value as "s" | "m");
                      }}
                      className="border border-gray-200 rounded px-2 py-0.5 text-sm"
                    >
                      <option value="s">S</option>
                      <option value="m">M</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 text-gray-900">
                    {o.remaining_today}
                  </td>
                  <td className="px-4 py-3 text-gray-900">
                    Rp {o.total_price.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-3 text-gray-900">
                    {o.customers?.area}
                  </td>
                  <td className="px-4 py-3 text-gray-900">{o.start_date}</td>
                  <td className="px-4 py-3 text-gray-900">
                    {o.created_at?.slice(0, 10)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[o.status] ?? "bg-gray-100 text-gray-500"}`}
                    >
                      {STATUS_LABELS[o.status] ?? o.status}
                    </span>
                  </td>
                </tr>
              ))}
              {filteredOrders.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
                    className="px-4 py-10 text-center text-gray-400"
                  >
                    No orders.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail slide-over */}
      {selected && editForm && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            aria-label="Close"
            className="absolute inset-0 h-auto w-auto rounded-none bg-black/20 cursor-default hover:bg-black/20"
            onClick={closeDetail}
          />
          <div className="relative w-full max-w-md bg-white shadow-xl overflow-y-auto">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                Order Detail
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={closeDetail}
                className="text-gray-400 hover:text-gray-600 h-auto p-0"
              >
                ✕
              </Button>
            </div>

            <div className="p-5 space-y-4">
              {/* Read-only summary */}
              <div className="rounded-lg bg-gray-50 p-3 space-y-1.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-900">
                    {selected.customers?.name ?? "Unknown"}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[selected.status] ?? "bg-gray-100 text-gray-500"}`}
                  >
                    {STATUS_LABELS[selected.status] ?? selected.status}
                  </span>
                </div>
                <div className="text-xs text-gray-400">
                  {selected.customers?.phone_number}
                </div>
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <div>
                    <span className="text-xs text-gray-500 block mb-1">
                      Package (porsi)
                    </span>
                    <p className="text-sm text-gray-900 py-2">
                      {selected.package_size}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 block mb-1">
                      Remaining
                    </span>
                    <p className="text-sm text-gray-900 py-2">
                      {selected.remaining_today}
                      <span className="ml-2 text-xs text-gray-500">
                        ({selected.unbooked} belum dijadwalkan)
                      </span>
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 block mb-1">
                      Price/porsi (Rp)
                    </span>
                    <p className="text-sm text-gray-900 py-2">
                      Rp {selected.price_per_portion.toLocaleString("id-ID")}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 block mb-1">
                      Total (Rp)
                    </span>
                    <p className="text-sm text-gray-900 py-2">
                      Rp {selected.total_price.toLocaleString("id-ID")}
                    </p>
                  </div>
                  <div>
                    <Label
                      htmlFor="order-start"
                      className="text-xs text-gray-500 block mb-1"
                    >
                      Start date
                    </Label>
                    <Input
                      id="order-start"
                      type="date"
                      value={editForm.start_date}
                      onChange={(e) =>
                        setEditForm({ ...editForm, start_date: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 block mb-1">
                      Paid date
                    </span>
                    <p className="text-sm text-gray-900 py-2">
                      {selected.paid_at ? selected.paid_at.slice(0, 10) : "—"}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 block mb-1">
                      Created
                    </span>
                    <p className="text-sm text-gray-500 py-2">
                      {selected.created_at?.slice(0, 10)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Area/address are customer-level data — edit on the Customers page, not per order */}
              <div className="rounded-lg bg-gray-50 p-3 text-sm">
                <span className="text-xs text-gray-500 block mb-1">
                  Delivery area
                </span>
                <p className="text-gray-900">
                  {selected.customers?.area ?? "—"}
                </p>
              </div>

              {/* Editable operational fields */}
              <div>
                <Label
                  htmlFor="order-sub"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Assigned Subcontractor
                </Label>
                <select
                  id="order-sub"
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

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label
                    htmlFor="order-size"
                    className="text-xs text-gray-500 block mb-1"
                  >
                    Size
                  </Label>
                  <select
                    id="order-size"
                    value={editForm.size}
                    onChange={(e) =>
                      setEditForm({ ...editForm, size: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value="s">S</option>
                    <option value="m">M</option>
                  </select>
                </div>
                <div>
                  <Label
                    htmlFor="order-end"
                    className="text-xs text-gray-500 block mb-1"
                  >
                    End Date
                  </Label>
                  <Input
                    id="order-end"
                    type="date"
                    value={editForm.end_date}
                    onChange={(e) =>
                      setEditForm({ ...editForm, end_date: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label
                    htmlFor="order-ppd"
                    className="text-xs text-gray-500 block mb-1"
                  >
                    Porsi/kirim
                  </Label>
                  <Input
                    id="order-ppd"
                    type="number"
                    value={editForm.portions_per_delivery}
                    onChange={(e) =>
                      setEditForm({
                        ...editForm,
                        portions_per_delivery: e.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <Label
                    htmlFor="order-pl"
                    className="text-xs text-gray-500 block mb-1"
                  >
                    Porsi lunch
                  </Label>
                  <Input
                    id="order-pl"
                    type="number"
                    value={editForm.portions_lunch}
                    onChange={(e) =>
                      setEditForm({
                        ...editForm,
                        portions_lunch: e.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <Label
                    htmlFor="order-pdn"
                    className="text-xs text-gray-500 block mb-1"
                  >
                    Porsi dinner
                  </Label>
                  <Input
                    id="order-pdn"
                    type="number"
                    value={editForm.portions_dinner}
                    onChange={(e) =>
                      setEditForm({
                        ...editForm,
                        portions_dinner: e.target.value,
                      })
                    }
                  />
                </div>
              </div>

              <div>
                <Label
                  htmlFor="order-addon"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Tambahan / porsi (Rp)
                </Label>
                <Input
                  id="order-addon"
                  type="number"
                  value={editForm.addon_cost_per_portion}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      addon_cost_per_portion: e.target.value,
                    })
                  }
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Biaya dapur, mis. nasi merah. Harga pelanggan sudah termasuk
                  ini — ini hanya menaikkan COGS pengiriman berikutnya.
                </p>
              </div>

              <div>
                <Label
                  htmlFor="order-amount-paid"
                  className="text-xs text-gray-500 block mb-1"
                >
                  Sudah dibayar (Rp)
                </Label>
                <Input
                  id="order-amount-paid"
                  type="number"
                  value={editForm.amount_paid}
                  onChange={(e) =>
                    setEditForm({ ...editForm, amount_paid: e.target.value })
                  }
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Untuk DP / pembayaran bertahap. Total pesanan tetap Rp{" "}
                  {selected.total_price.toLocaleString("id-ID")} — isi di sini
                  yang sudah masuk.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label
                    htmlFor="order-las"
                    className="text-xs text-gray-500 block mb-1"
                  >
                    Lunch address slot
                  </Label>
                  <select
                    id="order-las"
                    value={editForm.lunch_address_slot}
                    onChange={(e) =>
                      setEditForm({
                        ...editForm,
                        lunch_address_slot: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value={1}>1 (Primary)</option>
                    <option value={2}>2 (Address 2)</option>
                  </select>
                </div>
                <div>
                  <Label
                    htmlFor="order-das"
                    className="text-xs text-gray-500 block mb-1"
                  >
                    Dinner address slot
                  </Label>
                  <select
                    id="order-das"
                    value={editForm.dinner_address_slot}
                    onChange={(e) =>
                      setEditForm({
                        ...editForm,
                        dinner_address_slot: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value={1}>1 (Primary)</option>
                    <option value={2}>2 (Address 2)</option>
                  </select>
                </div>
              </div>

              <div className="pt-2">
                <Button
                  type="button"
                  onClick={saveFields}
                  disabled={busy}
                  className="w-full"
                >
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              </div>

              {/* Status controls */}
              <div className="border-t border-gray-100 pt-4 space-y-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  Status
                </p>
                {PENDING_STATUSES.includes(selected.status) && (
                  <Button
                    type="button"
                    variant="default"
                    onClick={markPaid}
                    disabled={busy}
                    className="w-full"
                  >
                    Mark Paid (activate order)
                  </Button>
                )}
                <div>
                  <Label
                    htmlFor="order-status"
                    className="text-xs text-gray-500 block mb-1"
                  >
                    Change status
                  </Label>
                  <select
                    id="order-status"
                    value=""
                    onChange={(e) => changeStatus(e.target.value)}
                    disabled={busy}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value="">— Select new status —</option>
                    <option value="paused">Paused</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled_by_admin">
                      Cancelled (Admin)
                    </option>
                    <option value="refunded">Refunded</option>
                  </select>
                </div>
              </div>

              {/* Draw ledger — this package's credit and every delivery
                  charged against it. Unlike the customer ledger, a wrong
                  order_id shows up here as a balance that goes negative. */}
              <div className="border-t border-gray-100 pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                    Draw history
                  </p>
                  {ledger && (
                    <p className="text-xs text-gray-500">
                      Sisa:{" "}
                      <span
                        className={`font-semibold ${ledger.remaining < 0 ? "text-red-600" : "text-gray-900"}`}
                      >
                        {ledger.remaining}
                      </span>
                    </p>
                  )}
                </div>
                {ledgerLoading ? (
                  <p className="text-sm text-gray-400">Memuat…</p>
                ) : !ledger || ledger.rows.length === 0 ? (
                  <p className="text-sm text-gray-400">Belum ada riwayat.</p>
                ) : (
                  <div className="max-h-64 overflow-y-auto border border-gray-100 rounded-lg">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr className="text-gray-500">
                          <th className="text-left px-2 py-1.5 font-medium">
                            Tanggal
                          </th>
                          <th className="text-left px-2 py-1.5 font-medium">
                            Keterangan
                          </th>
                          <th className="text-right px-2 py-1.5 font-medium">
                            Porsi
                          </th>
                          <th className="text-right px-2 py-1.5 font-medium">
                            Sisa
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {ledger.rows.map((r) => (
                          <tr
                            key={r.id}
                            className={
                              r.scheduled ? "text-gray-400" : "text-gray-700"
                            }
                          >
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {r.date || "—"}
                            </td>
                            <td className="px-2 py-1.5">
                              {r.kind === "package"
                                ? r.label
                                : [
                                    r.meal_type === "dinner"
                                      ? "Malam"
                                      : "Siang",
                                    r.label,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </td>
                            <td
                              className={`px-2 py-1.5 text-right font-medium tabular-nums ${r.change < 0 ? "text-red-600" : "text-green-600"}`}
                            >
                              {r.change > 0 ? `+${r.change}` : r.change}
                            </td>
                            <td
                              className={`px-2 py-1.5 text-right tabular-nums font-medium ${r.balance < 0 ? "text-red-600" : "text-gray-900"}`}
                            >
                              {r.balance}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="border-t border-gray-100 pt-4 space-y-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  Danger zone
                </p>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setDeleteConfirmOpen(true)}
                  disabled={busy}
                  className="w-full"
                >
                  Delete order
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmOpen && selected && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">
              Delete order?
            </h2>
            <p className="text-xs text-gray-600 mb-4">
              This will permanently delete the order for{" "}
              <span className="font-medium text-gray-900">
                {selected.customers?.name ??
                  selected.customers?.phone_number ??
                  "Unknown"}
              </span>
              , including its scheduled deliveries. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDeleteConfirmOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={deleteOrder}
                disabled={busy}
              >
                {busy ? "Deleting..." : "Delete permanently"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
