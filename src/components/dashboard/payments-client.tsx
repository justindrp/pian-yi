"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
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
        .select("*, customers!orders_customer_id_fkey(*)")
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
        .select("*, customers!orders_customer_id_fkey(*)")
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
        .select("*, customers!orders_customer_id_fkey(*)")
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
        body: JSON.stringify({ id: orderId, action: "mark_paid" }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Failed");
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
      const { error } = await supabase
        .from("orders")
        .update({ status: "pending_payment", cancellation_reason: reason })
        .eq("id", orderId);
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      setRejectOrderId(null);
      setRejectReason("");
    },
  });

  const tabs: { key: Tab; label: string; count: number }[] = [
    {
      key: "awaiting_payment",
      label: "Awaiting payment",
      count: awaitingPayment.length,
    },
    {
      key: "pending_verification",
      label: "Pending verification",
      count: pendingVerification.length,
    },
    { key: "paid_today", label: "Paid today", count: paidToday.length },
  ];

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900 mb-6">Payments</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-lg w-fit">
        {tabs.map((t) => (
          <Button
            type="button"
            key={t.key}
            size="sm"
            variant="ghost"
            onClick={() => setTab(t.key)}
            className={
              tab === t.key
                ? "bg-white text-gray-900 shadow-sm hover:bg-white"
                : "text-gray-500 hover:text-gray-700"
            }
          >
            {t.label}
            {t.count > 0 && (
              <span className="ml-1.5 text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">
                {t.count}
              </span>
            )}
          </Button>
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
                      <p className="text-xs text-gray-900 mt-0.5">
                        {order.package_size} porsi ·{" "}
                        {formatIDR(order.total_price)}
                      </p>
                      {order.confirmed_at && (
                        <p className="text-xs text-gray-900 mt-1">
                          Proof received {formatDateTime(order.confirmed_at)}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="success"
                        onClick={() => markPaidMutation.mutate(order.id)}
                        disabled={markPaidMutation.isPending}
                      >
                        Mark as paid
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setRejectOrderId(order.id)}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>

                  {/* Reject form */}
                  {rejectOrderId === order.id && (
                    <div className="mt-3 pt-3 border-t border-gray-100">
                      <Input
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Reason for rejection..."
                        className="mb-2"
                      />
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            rejectMutation.mutate({
                              orderId: order.id,
                              reason: rejectReason,
                            })
                          }
                          disabled={rejectMutation.isPending}
                        >
                          Confirm reject
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRejectOrderId(null);
                            setRejectReason("");
                          }}
                        >
                          Cancel
                        </Button>
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
                        <p className="text-xs text-gray-900 mt-0.5">
                          {order.package_size} porsi ·{" "}
                          {formatIDR(order.total_price)}
                        </p>
                      </div>
                      {order.confirmed_at && (
                        <p className="text-xs text-gray-900">
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
                      <p className="text-xs text-gray-900 mt-0.5">
                        {order.package_size} porsi ·{" "}
                        {formatIDR(order.total_price)}
                      </p>
                    </div>
                    {order.paid_at && (
                      <p className="text-xs text-gray-900">
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
