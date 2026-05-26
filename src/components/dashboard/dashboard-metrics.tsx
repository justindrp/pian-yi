"use client";

import { useQuery } from "@tanstack/react-query";
import KillSwitch from "@/components/dashboard/kill-switch";
import { formatIDR } from "@/lib/utils/format";

type Metrics = {
  activeCustomers: number;
  deliveriesToday: number;
  pendingPayments: number;
  revenueToday: number;
  pendingProofs: number;
  lapsedCustomers: number;
  chatbotEnabled: boolean;
};

async function fetchMetrics(): Promise<Metrics> {
  const res = await fetch("/api/dashboard/metrics", { cache: "no-store" });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "Failed to load metrics");
  return json.data;
}

export default function DashboardMetrics() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["dashboard-metrics"],
    queryFn: fetchMetrics,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  if (isError) {
    return (
      <div className="bg-red-50 border border-red-100 rounded-xl p-4 text-sm text-red-700">
        Couldn’t load dashboard metrics: {(error as Error).message}
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <StatCard label="Active Customers" value={data?.activeCustomers} loading={isLoading} />
        <StatCard label="Deliveries Today" value={data?.deliveriesToday} loading={isLoading} />
        <StatCard
          label="Pending Payments"
          value={data?.pendingPayments}
          loading={isLoading}
          highlight={!!data && data.pendingPayments > 0}
        />
        <StatCard
          label="Revenue Today"
          value={data ? formatIDR(data.revenueToday) : undefined}
          loading={isLoading}
        />
        <StatCard
          label="Pending Delivery Photos"
          value={data?.pendingProofs}
          loading={isLoading}
          highlight={!!data && data.pendingProofs > 0}
        />
        <StatCard
          label="Lapsed Customers"
          value={data?.lapsedCustomers}
          loading={isLoading}
          highlight={!!data && data.lapsedCustomers > 0}
        />
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <h2 className="text-sm font-medium text-gray-900 mb-1">AI Chatbot</h2>
        <p className="text-xs text-gray-500 mb-4">
          Disable to stop all AI responses. Customers will receive a fallback message.
        </p>
        {isLoading || !data ? (
          <div className="h-6 w-32 rounded bg-gray-100 animate-pulse" />
        ) : (
          <KillSwitch initialEnabled={data.chatbotEnabled} />
        )}
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  highlight,
  loading,
}: {
  label: string;
  value: string | number | undefined;
  highlight?: boolean;
  loading?: boolean;
}) {
  return (
    <div
      className={`bg-white rounded-xl border p-4 ${highlight ? "border-orange-200" : "border-gray-100"}`}
    >
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      {loading || value === undefined ? (
        <div className="h-8 w-16 rounded bg-gray-100 animate-pulse mt-1" />
      ) : (
        <p
          className={`text-2xl font-semibold ${highlight ? "text-orange-600" : "text-gray-900"}`}
        >
          {value}
        </p>
      )}
    </div>
  );
}
