"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

interface ConversionRow {
  id: string;
  name: string | null;
  area: string | null;
  ad_creative: string | null;
  package: string | null;
  total_portions: number | null;
  total_payment: number | null;
  promo_used: string | null;
  converted_to_subscription: boolean;
  notes: string | null;
  converted_at: string;
}

interface CreativeBreakdown {
  creative: string;
  conversions: number;
  revenue: number;
  avgOrderValue: number;
  subscribed: number;
  subscriptionRate: number;
}

interface ConversionData {
  totalConversions: number;
  conversionsThisMonth: number;
  totalRevenue: number;
  revenueThisMonth: number;
  topCreative: string | null;
  organicConversions: number;
  byCreative: CreativeBreakdown[];
  log: ConversionRow[];
  total: number;
  page: number;
}

interface ReportData {
  revenue: number;
  prevRevenue: number;
  grossProfit: number;
  justinShare: number;
  annieShare: number;
  totalPortions: number;
  activeCustomers: number;
  newCustomers: number;
  avgOrderValue: number;
  subcontractorStats: { id: string; name: string; total_deliveries: number; late_deliveries: number; on_time_rate: number | null }[];
  portionsByDay: Record<string, number>;
  aiCost: number;
  sonnetInputTokens: number;
  sonnetOutputTokens: number;
  haikuInputTokens: number;
  haikuOutputTokens: number;
  escalationRate: number;
}

function formatIDR(n: number) {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

function trend(current: number, prev: number) {
  if (prev === 0) return null;
  const pct = Math.round(((current - prev) / prev) * 100);
  return pct;
}

export default function ReportsClient() {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<"overview" | "conversions">("overview");

  const { data, isLoading } = useQuery({
    queryKey: ["reports", days],
    queryFn: async () => {
      const res = await fetch(`/api/reports?days=${days}`);
      const json = await res.json() as { ok: boolean; data: ReportData };
      return json.data;
    },
    staleTime: 5 * 60 * 1000,
  });

  const portionDays = Object.entries(data?.portionsByDay ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const maxPortions = Math.max(...portionDays.map(([, v]) => v), 1);

  const revenueTrend = data ? trend(data.revenue, data.prevRevenue) : null;

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Reports</h1>
        <div className="flex border border-gray-200 rounded-lg overflow-hidden text-sm">
          <button type="button" onClick={() => setTab("overview")} className={`px-4 py-1.5 ${tab === "overview" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"}`}>Overview</button>
          <button type="button" onClick={() => setTab("conversions")} className={`px-4 py-1.5 ${tab === "conversions" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"}`}>Conversions</button>
        </div>
        {tab === "overview" && (
          <div className="flex border border-gray-200 rounded-lg overflow-hidden text-sm ml-auto">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)} className={`px-4 py-1.5 ${days === d ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"}`}>{d}d</button>
            ))}
          </div>
        )}
      </div>

      {tab === "conversions" && <ConversionTracking />}

      {tab === "overview" && isLoading && (
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />)}
        </div>
      )}
      {tab === "overview" && !isLoading && (
        <div className="space-y-6">
          {/* Section 1: Overview */}
          <section>
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">Business Overview</h2>
            <div className="grid grid-cols-4 gap-4">
              <StatCard label="Revenue" value={formatIDR(data?.revenue ?? 0)} trend={revenueTrend} />
              <StatCard label="Gross Profit" value={formatIDR(data?.grossProfit ?? 0)} />
              <StatCard label="Justin (60%)" value={formatIDR(data?.justinShare ?? 0)} />
              <StatCard label="Annie (40%)" value={formatIDR(data?.annieShare ?? 0)} />
              <StatCard label="Total Portions" value={`${data?.totalPortions ?? 0}`} />
              <StatCard label="Active Customers" value={`${data?.activeCustomers ?? 0}`} />
              <StatCard label="New Customers" value={`${data?.newCustomers ?? 0}`} />
              <StatCard label="Avg Order Value" value={formatIDR(data?.avgOrderValue ?? 0)} />
            </div>
          </section>

          {/* Section 2: Portions per day */}
          <section>
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">Portions Delivered / Day</h2>
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              {portionDays.length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-8">No delivery data yet.</p>
              ) : (
                <div className="flex items-end gap-1 h-32">
                  {portionDays.map(([date, portions]) => (
                    <div key={date} className="flex-1 flex flex-col items-center gap-1 group relative">
                      <div
                        className="w-full bg-blue-500 rounded-t"
                        style={{ height: `${(portions / maxPortions) * 100}%` }}
                      />
                      <div className="absolute bottom-full mb-1 bg-gray-800 text-white text-xs px-2 py-1 rounded hidden group-hover:block whitespace-nowrap">
                        {date}: {portions} porsi
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Section 3: Subcontractor performance */}
          <section>
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">Subcontractor Performance</h2>
            <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="px-4 py-3 text-left">Subcontractor</th>
                    <th className="px-4 py-3 text-left">Total Deliveries</th>
                    <th className="px-4 py-3 text-left">Late</th>
                    <th className="px-4 py-3 text-left">On-time rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {(data?.subcontractorStats ?? []).map((s) => (
                    <tr key={s.id}>
                      <td className="px-4 py-3 font-medium text-gray-900">{s.name}</td>
                      <td className="px-4 py-3 text-gray-600">{s.total_deliveries}</td>
                      <td className="px-4 py-3 text-gray-600">{s.late_deliveries}</td>
                      <td className="px-4 py-3">
                        {s.on_time_rate !== null ? (
                          <span className={`font-medium ${s.on_time_rate >= 90 ? "text-green-600" : s.on_time_rate >= 70 ? "text-amber-600" : "text-red-600"}`}>
                            {s.on_time_rate}%
                          </span>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                  {(data?.subcontractorStats ?? []).length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">No delivery data yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Section 4: AI Cost */}
          <section>
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">Chatbot & AI</h2>
            <div className="grid grid-cols-4 gap-4">
              <StatCard label="AI Cost (est.)" value={`$${data?.aiCost ?? 0}`} />
              <StatCard label="Escalation rate" value={`${data?.escalationRate ?? 0}%`} />
              <StatCard label="Sonnet tokens" value={`${((data?.sonnetInputTokens ?? 0) + (data?.sonnetOutputTokens ?? 0)).toLocaleString()}`} />
              <StatCard label="Haiku tokens" value={`${((data?.haikuInputTokens ?? 0) + (data?.haikuOutputTokens ?? 0)).toLocaleString()}`} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ConversionTracking() {
  const defaultEnd = new Date().toISOString().slice(0, 10);
  const defaultStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [page, setPage] = useState(1);
  const perPage = 20;

  const { data, isLoading } = useQuery({
    queryKey: ["conversions", startDate, endDate, page],
    queryFn: async () => {
      const params = new URLSearchParams({ startDate, endDate, page: String(page), perPage: String(perPage) });
      const res = await fetch(`/api/reports/conversions?${params}`);
      const json = await res.json() as { ok: boolean; data: ConversionData };
      return json.data;
    },
    staleTime: 2 * 60 * 1000,
  });

  async function exportCSV() {
    const params = new URLSearchParams({ startDate, endDate, export: "true" });
    const res = await fetch(`/api/reports/conversions?${params}`);
    const json = await res.json() as { ok: boolean; data: ConversionData };
    const rows = json.data?.log ?? [];
    const headers = ["Date", "Customer", "Area", "Creative", "Package", "Portions", "Payment (Rp)", "Promo", "Subscribed", "Notes"];
    const csvRows = [
      headers.join(","),
      ...rows.map((r) =>
        [
          r.converted_at.slice(0, 10),
          `"${r.name ?? ""}"`,
          r.area ?? "",
          r.ad_creative ?? "Organic",
          r.package ?? "",
          r.total_portions ?? "",
          r.total_payment ?? "",
          `"${r.promo_used ?? ""}"`,
          r.converted_to_subscription ? "Yes" : "No",
          `"${(r.notes ?? "").replace(/"/g, '""')}"`,
        ].join(","),
      ),
    ];
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `conversions_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalPages = Math.ceil((data?.total ?? 0) / perPage);

  return (
    <div className="space-y-6">
      {/* Date range filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-gray-500">From</label>
        <input
          type="date"
          value={startDate}
          onChange={(e) => { setStartDate(e.target.value); setPage(1); }}
          className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
        />
        <label className="text-sm text-gray-500">to</label>
        <input
          type="date"
          value={endDate}
          onChange={(e) => { setEndDate(e.target.value); setPage(1); }}
          className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
        />
        <button
          type="button"
          onClick={exportCSV}
          className="ml-auto px-4 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50"
        >
          Export CSV
        </button>
      </div>

      {/* Summary cards */}
      {isLoading ? (
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />)}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Total Conversions" value={String(data?.totalConversions ?? 0)} />
          <StatCard label="Conversions This Month" value={String(data?.conversionsThisMonth ?? 0)} />
          <StatCard label="Total Revenue" value={formatIDR(data?.totalRevenue ?? 0)} />
          <StatCard label="Revenue This Month" value={formatIDR(data?.revenueThisMonth ?? 0)} />
          <StatCard label="Top Creative" value={data?.topCreative ?? "—"} />
          <StatCard label="Organic Conversions" value={String(data?.organicConversions ?? 0)} />
        </div>
      )}

      {/* Per-creative breakdown */}
      {!isLoading && (data?.byCreative ?? []).length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">By Creative</h2>
          <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3 text-left">Creative</th>
                  <th className="px-4 py-3 text-right">Conversions</th>
                  <th className="px-4 py-3 text-right">Revenue</th>
                  <th className="px-4 py-3 text-right">Avg Order</th>
                  <th className="px-4 py-3 text-right">Subscribed</th>
                  <th className="px-4 py-3 text-right">Sub Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {(data?.byCreative ?? []).map((row) => (
                  <tr key={row.creative}>
                    <td className="px-4 py-3 font-medium text-gray-900">{row.creative}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{row.conversions}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{formatIDR(row.revenue)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{formatIDR(row.avgOrderValue)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{row.subscribed}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{row.subscriptionRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Conversion log */}
      <section>
        <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">Conversion Log</h2>
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Area</th>
                <th className="px-4 py-3 text-left">Creative</th>
                <th className="px-4 py-3 text-left">Package</th>
                <th className="px-4 py-3 text-right">Payment</th>
                <th className="px-4 py-3 text-left">Promo</th>
                <th className="px-4 py-3 text-center">Sub</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
              )}
              {!isLoading && (data?.log ?? []).length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No conversions in this period.</td></tr>
              )}
              {(data?.log ?? []).map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{row.converted_at.slice(0, 10)}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{row.name ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{row.area ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{row.ad_creative ?? <span className="text-gray-400 italic">Organic</span>}</td>
                  <td className="px-4 py-3 text-gray-600">{row.package ?? "—"}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{row.total_payment != null ? formatIDR(row.total_payment) : "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{row.promo_used ?? "—"}</td>
                  <td className="px-4 py-3 text-center">{row.converted_to_subscription ? "✓" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-sm text-gray-500">Page {page} of {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-600 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value, trend: trendPct }: { label: string; value: string; trend?: number | null }) {
  return (
    <div className="bg-white border border-gray-100 rounded-xl px-4 py-4">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-xl font-semibold text-gray-900">{value}</div>
      {trendPct !== null && trendPct !== undefined && (
        <div className={`text-xs mt-0.5 ${trendPct >= 0 ? "text-green-600" : "text-red-500"}`}>
          {trendPct >= 0 ? "+" : ""}{trendPct}% vs prev period
        </div>
      )}
    </div>
  );
}
