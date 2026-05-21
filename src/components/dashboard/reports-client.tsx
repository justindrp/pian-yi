"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

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
        <div className="flex border border-gray-200 rounded-lg overflow-hidden text-sm ml-auto">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} className={`px-4 py-1.5 ${days === d ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"}`}>{d}d</button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />)}
        </div>
      ) : (
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
