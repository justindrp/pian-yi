"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

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
  created_at: string;
  customers?: { name: string | null; phone_number: string };
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

export default function OrdersClient() {
  const [statusFilter, setStatusFilter] = useState("active");

  const { data: orders, isLoading } = useQuery({
    queryKey: ["orders", statusFilter],
    queryFn: async () => {
      const res = await fetch(`/api/orders?status=${statusFilter}`);
      const json = await res.json() as { ok: boolean; data: Order[] };
      return json.data;
    },
  });

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <h1 className="text-xl font-semibold text-gray-900">Orders</h1>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm ml-auto">
          <option value="active">Active</option>
          <option value="pending_payment">Pending Payment</option>
          <option value="payment_proof_received">Proof Received</option>
          <option value="completed">Completed</option>
          <option value="paused">Paused</option>
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 bg-gray-100 rounded-xl animate-pulse" />)}</div>
      ) : (
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Package</th>
                <th className="px-4 py-3 text-left">Remaining</th>
                <th className="px-4 py-3 text-left">Total</th>
                <th className="px-4 py-3 text-left">Area</th>
                <th className="px-4 py-3 text-left">Start date</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {(orders ?? []).map((o) => (
                <tr key={o.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{o.customers?.name ?? "Unknown"}</div>
                    <div className="text-xs text-gray-400">{o.customers?.phone_number}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-900">{o.package_size} porsi</td>
                  <td className="px-4 py-3 text-gray-900">{o.portions_remaining}</td>
                  <td className="px-4 py-3 text-gray-900">Rp {o.total_price.toLocaleString("id-ID")}</td>
                  <td className="px-4 py-3 text-gray-900">{o.area}</td>
                  <td className="px-4 py-3 text-gray-900">{o.start_date}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[o.status] ?? "bg-gray-100 text-gray-500"}`}>
                      {STATUS_LABELS[o.status] ?? o.status}
                    </span>
                  </td>
                </tr>
              ))}
              {(orders ?? []).length === 0 && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">No orders.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
