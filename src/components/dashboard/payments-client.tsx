"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useState } from "react";
import { formatDateTime, formatIDR } from "@/lib/utils/format";
import type { Database } from "@/types/database";

type Order = Database["public"]["Tables"]["orders"]["Row"];
type Customer = Database["public"]["Tables"]["customers"]["Row"];

type OrderWithCustomer = Order & { customers: Customer | null };

type Tab = "pending_verification" | "awaiting_payment" | "paid_today";

export default function PaymentsClient() {
  const [tab, setTab] = useState<Tab>("pending_verification");
  const [rejectOrderId, setRejectOrderId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const queryClient = useQueryClient();
  const supabase = createClient();

  const { data: pendingVerification = [], isLoading: lvLoading } = useQuery({
    queryKey: ["orders", "payment_proof_received"],
    queryFn: async () => {
      const { data } = await supabase
        .from("orders")
        .select("*, customers(*)")
        .eq("status", "payment_proof_received")
        .order("confirmed_at", { ascending: true });
      return (data ?? []) as OrderWithCustomer[];
    },
  });

  const { data: awaitingPayment = [], isLoading: lapLoading } = useQuery({
    queryKey: ["orders", "pending_payment"],
    queryFn: async () => {
      const { data } = await supabase
        .from("orders")
        .select("*, customers(*)")
        .eq("status", "pending_payment")
        .order("confirmed_at", { ascending: true });
      return (data ?? []) as OrderWithCustomer[];
    },
  });

  const { data: paidToday = [], isLoading: ptLoading } = useQuery({
    queryKey: ["orders", "paid_today"],
    queryFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const { data } = await supabase
        .from("orders")
        .select("*, customers(*)")
        .gte("paid_at", today.toISOString())
        .order("paid_at", { ascending: false });
      return (data ?? []) as OrderWithCustomer[];
    },
  });

  const markPaidMutation = useMutation({
    mutationFn: async (orderId: string) => {
      const res = await fetch("/api/orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: orderId, status: "active" }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Failed to mark as paid");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async ({
      orderId,
      reason,
    }: {
      orderId: string;
      reason: string;
    }) => {
      const res = await fetch("/api/orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: orderId,
          status: "pending_payment",
          cancellation_reason: reason,
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Failed to reject");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      setRejectOrderId(null);
      setRejectReason("");
    },
  });

  const tabs: { key: Tab; label: string; count: number }[] = [
    {
      key: "pending_verification",
      label: "Pending verification",
      count: pendingVerification.length,
    },
    {
      key: "awaiting_payment",
      label: "Awaiting payment",
      count: awaitingPayment.length,
    },
    { key: "paid_today", label: "Paid today", count: paidToday.length },
  ];

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900 mb-6">Payments</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-lg w-fit">
        {tabs.map((t) => (
          <button
            type="button"
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
              tab === t.key
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
            {t.count > 0 && (
              <span className="ml-1.5 text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Pending verification */}
      {tab === "pending_verification" && (
        <div className="space-y-3">
          {lvLoading
            ? (["a", "b", "c"] as const).map((id) => (
                <div
                  key={id}
                  className="h-24 bg-gray-100 rounded-xl animate-pulse"
                />
              ))
            : pendingVerification.map((order) => (
                <div
                  key={order.id}
                  className="bg-white border border-gray-100 rounded-xl p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {order.customers?.name ??
                          order.customers?.phone_number ??
                          "Unknown"}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {order.package_size} porsi ·{" "}
                        {formatIDR(order.total_price)}
                      </p>
                      {order.confirmed_at && (
                        <p className="text-xs text-gray-400 mt-1">
                          Proof received {formatDateTime(order.confirmed_at)}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => markPaidMutation.mutate(order.id)}
                        disabled={markPaidMutation.isPending}
                        className="text-xs px-3 py-1.5 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 transition-colors"
                      >
                        Mark as paid
                      </button>
                      <button
                        type="button"
                        onClick={() => setRejectOrderId(order.id)}
                        className="text-xs px-3 py-1.5 border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
                      >
                        Reject
                      </button>
                    </div>
                  </div>

                  {/* Reject form */}
                  {rejectOrderId === order.id && (
                    <div className="mt-3 pt-3 border-t border-gray-100">
                      <input
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Reason for rejection..."
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none mb-2"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            rejectMutation.mutate({
                              orderId: order.id,
                              reason: rejectReason,
                            })
                          }
                          disabled={rejectMutation.isPending}
                          className="text-xs px-3 py-1.5 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
                        >
                          Confirm reject
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRejectOrderId(null);
                            setRejectReason("");
                          }}
                          className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
          {!lvLoading && pendingVerification.length === 0 && (
            <p className="text-sm text-gray-400">No pending verifications.</p>
          )}
        </div>
      )}

      {/* Awaiting payment */}
      {tab === "awaiting_payment" && (
        <div className="space-y-3">
          {lapLoading
            ? (["a", "b", "c"] as const).map((id) => (
                <div
                  key={id}
                  className="h-20 bg-gray-100 rounded-xl animate-pulse"
                />
              ))
            : awaitingPayment.map((order) => {
                const elapsed = order.confirmed_at
                  ? Date.now() - new Date(order.confirmed_at).getTime()
                  : 0;
                const hours = elapsed / (1000 * 60 * 60);
                const color =
                  hours < 1
                    ? "border-green-200"
                    : hours < 4
                      ? "border-yellow-200"
                      : "border-red-200";
                return (
                  <div
                    key={order.id}
                    className={`bg-white border ${color} rounded-xl p-4`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {order.customers?.name ??
                            order.customers?.phone_number ??
                            "Unknown"}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {order.package_size} porsi ·{" "}
                          {formatIDR(order.total_price)}
                        </p>
                      </div>
                      {order.confirmed_at && (
                        <p className="text-xs text-gray-400">
                          {formatDateTime(order.confirmed_at)}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
          {!lapLoading && awaitingPayment.length === 0 && (
            <p className="text-sm text-gray-400">No orders awaiting payment.</p>
          )}
        </div>
      )}

      {/* Paid today */}
      {tab === "paid_today" && (
        <div className="space-y-3">
          {ptLoading
            ? (["a", "b", "c"] as const).map((id) => (
                <div
                  key={id}
                  className="h-20 bg-gray-100 rounded-xl animate-pulse"
                />
              ))
            : paidToday.map((order) => (
                <div
                  key={order.id}
                  className="bg-white border border-gray-100 rounded-xl p-4"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {order.customers?.name ??
                          order.customers?.phone_number ??
                          "Unknown"}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {order.package_size} porsi ·{" "}
                        {formatIDR(order.total_price)}
                      </p>
                    </div>
                    {order.paid_at && (
                      <p className="text-xs text-gray-400">
                        {formatDateTime(order.paid_at)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
          {!ptLoading && paidToday.length === 0 && (
            <p className="text-sm text-gray-400">No payments today yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
