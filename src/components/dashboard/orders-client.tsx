"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import NewOrderModal from "./new-order-modal";

interface Order {
  id: string;
  customer_id: string;
  package_size: number;
  portions_remaining: number;
  total_price: number;
  status: string;
  start_date: string;
  area: string;
  meal_time_preference: string;
  size: string;
  created_at: string;
  order_type: string;
  delivery_address: string;
  maps_link: string | null;
  subcontractor_id: string | null;
  end_date: string | null;
  price_per_portion: number;
  paid_at: string | null;
  portions_lunch: number | null;
  portions_dinner: number | null;
  portions_per_delivery: number;
  lunch_address_slot: number;
  dinner_address_slot: number;
  customers?: { name: string | null; phone_number: string };
}

const DELIVERY_AREAS = [
  "BSD Baru",
  "BSD Lama",
  "Gading Serpong",
  "Alam Sutera",
  "Bintaro",
  "Graha Raya",
];

const MEAL_PREFERENCES = [
  "lunch_only",
  "dinner_only",
  "both_fixed",
  "per_day_decision",
  "default_lunch",
  "default_dinner",
  "custom_schedule",
];

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
  area: string;
  delivery_address: string;
  maps_link: string;
  subcontractor_id: string;
  meal_time_preference: string;
  end_date: string;
  size: string;
  lunch_address_slot: number;
  dinner_address_slot: number;
  portions_lunch: string;
  portions_dinner: string;
  portions_per_delivery: string;
};

export default function OrdersClient() {
  const [statusFilter, setStatusFilter] = useState("active");
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [selected, setSelected] = useState<Order | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

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
      area: o.area ?? "",
      delivery_address: o.delivery_address ?? "",
      maps_link: o.maps_link ?? "",
      subcontractor_id: o.subcontractor_id ?? "",
      meal_time_preference: o.meal_time_preference ?? "",
      end_date: o.end_date ?? "",
      size: o.size ?? "s",
      lunch_address_slot: o.lunch_address_slot ?? 1,
      dinner_address_slot: o.dinner_address_slot ?? 1,
      portions_lunch: o.portions_lunch == null ? "" : String(o.portions_lunch),
      portions_dinner: o.portions_dinner == null ? "" : String(o.portions_dinner),
      portions_per_delivery:
        o.portions_per_delivery == null ? "" : String(o.portions_per_delivery),
    });
  }

  function closeDetail() {
    setSelected(null);
    setEditForm(null);
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
        body: JSON.stringify({ id: selected.id, action: "update_status", status }),
      });
      qc.invalidateQueries({ queryKey: ["orders"] });
      closeDetail();
    } finally {
      setBusy(false);
    }
  }

  const { data: orders, isLoading } = useQuery({
    queryKey: ["orders", statusFilter],
    queryFn: async () => {
      const res = await fetch(`/api/orders?status=${statusFilter}`);
      const json = (await res.json()) as { ok: boolean; data: Order[] };
      return json.data;
    },
  });

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
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
        >
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
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
            <div key={`skel-${i}`} className="h-16 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Package</th>
                <th className="px-4 py-3 text-left">Size</th>
                <th className="px-4 py-3 text-left">Remaining</th>
                <th className="px-4 py-3 text-left">Total</th>
                <th className="px-4 py-3 text-left">Area</th>
                <th className="px-4 py-3 text-left">Start date</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {(orders ?? []).map((o) => (
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
                    {o.portions_remaining}
                  </td>
                  <td className="px-4 py-3 text-gray-900">
                    Rp {o.total_price.toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-3 text-gray-900">{o.area}</td>
                  <td className="px-4 py-3 text-gray-900">{o.start_date}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[o.status] ?? "bg-gray-100 text-gray-500"}`}
                    >
                      {STATUS_LABELS[o.status] ?? o.status}
                    </span>
                  </td>
                </tr>
              ))}
              {(orders ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={8}
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
              <h2 className="text-sm font-semibold text-gray-900">Order Detail</h2>
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
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600 pt-1">
                  <dt className="text-gray-400">Type</dt>
                  <dd>{selected.order_type}</dd>
                  <dt className="text-gray-400">Package</dt>
                  <dd>{selected.package_size} porsi</dd>
                  <dt className="text-gray-400">Remaining</dt>
                  <dd>{selected.portions_remaining}</dd>
                  <dt className="text-gray-400">Price/porsi</dt>
                  <dd>Rp {selected.price_per_portion?.toLocaleString("id-ID")}</dd>
                  <dt className="text-gray-400">Total</dt>
                  <dd>Rp {selected.total_price?.toLocaleString("id-ID")}</dd>
                  <dt className="text-gray-400">Start</dt>
                  <dd>{selected.start_date}</dd>
                  <dt className="text-gray-400">Created</dt>
                  <dd>{selected.created_at?.slice(0, 10)}</dd>
                  <dt className="text-gray-400">Paid</dt>
                  <dd>{selected.paid_at?.slice(0, 10) ?? "—"}</dd>
                </dl>
              </div>

              {/* Editable operational fields */}
              <div>
                <Label htmlFor="order-area" className="text-xs text-gray-500 block mb-1">
                  Area
                </Label>
                <select
                  id="order-area"
                  value={editForm.area}
                  onChange={(e) => setEditForm({ ...editForm, area: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— Select area —</option>
                  {DELIVERY_AREAS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label htmlFor="order-address" className="text-xs text-gray-500 block mb-1">
                  Delivery Address
                </Label>
                <Textarea
                  id="order-address"
                  value={editForm.delivery_address}
                  onChange={(e) =>
                    setEditForm({ ...editForm, delivery_address: e.target.value })
                  }
                  rows={2}
                  className="resize-none"
                />
              </div>

              <div>
                <Label htmlFor="order-maps" className="text-xs text-gray-500 block mb-1">
                  Google Maps Link
                </Label>
                <Input
                  id="order-maps"
                  value={editForm.maps_link}
                  onChange={(e) => setEditForm({ ...editForm, maps_link: e.target.value })}
                  placeholder="https://maps.app.goo.gl/..."
                />
              </div>

              <div>
                <Label htmlFor="order-sub" className="text-xs text-gray-500 block mb-1">
                  Assigned Subcontractor
                </Label>
                <select
                  id="order-sub"
                  value={editForm.subcontractor_id}
                  onChange={(e) =>
                    setEditForm({ ...editForm, subcontractor_id: e.target.value })
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
                <Label htmlFor="order-meal" className="text-xs text-gray-500 block mb-1">
                  Meal Time Preference
                </Label>
                <select
                  id="order-meal"
                  value={editForm.meal_time_preference}
                  onChange={(e) =>
                    setEditForm({ ...editForm, meal_time_preference: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— None —</option>
                  {MEAL_PREFERENCES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="order-size" className="text-xs text-gray-500 block mb-1">
                    Size
                  </Label>
                  <select
                    id="order-size"
                    value={editForm.size}
                    onChange={(e) => setEditForm({ ...editForm, size: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value="s">S</option>
                    <option value="m">M</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="order-end" className="text-xs text-gray-500 block mb-1">
                    End Date
                  </Label>
                  <Input
                    id="order-end"
                    type="date"
                    value={editForm.end_date}
                    onChange={(e) => setEditForm({ ...editForm, end_date: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="order-ppd" className="text-xs text-gray-500 block mb-1">
                    Porsi/kirim
                  </Label>
                  <Input
                    id="order-ppd"
                    type="number"
                    value={editForm.portions_per_delivery}
                    onChange={(e) =>
                      setEditForm({ ...editForm, portions_per_delivery: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="order-pl" className="text-xs text-gray-500 block mb-1">
                    Porsi lunch
                  </Label>
                  <Input
                    id="order-pl"
                    type="number"
                    value={editForm.portions_lunch}
                    onChange={(e) =>
                      setEditForm({ ...editForm, portions_lunch: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="order-pdn" className="text-xs text-gray-500 block mb-1">
                    Porsi dinner
                  </Label>
                  <Input
                    id="order-pdn"
                    type="number"
                    value={editForm.portions_dinner}
                    onChange={(e) =>
                      setEditForm({ ...editForm, portions_dinner: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="order-las" className="text-xs text-gray-500 block mb-1">
                    Lunch address slot
                  </Label>
                  <select
                    id="order-las"
                    value={editForm.lunch_address_slot}
                    onChange={(e) =>
                      setEditForm({ ...editForm, lunch_address_slot: Number(e.target.value) })
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value={1}>1 (Primary)</option>
                    <option value={2}>2 (Address 2)</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="order-das" className="text-xs text-gray-500 block mb-1">
                    Dinner address slot
                  </Label>
                  <select
                    id="order-das"
                    value={editForm.dinner_address_slot}
                    onChange={(e) =>
                      setEditForm({ ...editForm, dinner_address_slot: Number(e.target.value) })
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
                  <Label htmlFor="order-status" className="text-xs text-gray-500 block mb-1">
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
                    <option value="cancelled_by_admin">Cancelled (Admin)</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
