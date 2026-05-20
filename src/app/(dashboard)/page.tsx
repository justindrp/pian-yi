import KillSwitch from "@/components/dashboard/kill-switch";
import PushSubscribeButton from "@/components/dashboard/push-subscribe-button";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatIDR } from "@/lib/utils/format";

async function getMetrics() {
  const db = createAdminClient();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const [activeRes, deliveriesRes, pendingRes, revenueRes] = await Promise.all([
    db.from("orders").select("id", { count: "exact" }).eq("status", "active"),
    db
      .from("orders")
      .select("id", { count: "exact" })
      .eq("status", "active")
      .gte("start_date", todayStart.toISOString().split("T")[0])
      .lte("start_date", todayEnd.toISOString().split("T")[0]),
    db
      .from("orders")
      .select("id", { count: "exact" })
      .in("status", ["pending_payment", "payment_proof_received"]),
    db
      .from("orders")
      .select("total_price")
      .gte("paid_at", todayStart.toISOString())
      .lte("paid_at", todayEnd.toISOString()),
  ]);

  const revenue = (revenueRes.data ?? []).reduce(
    (sum, o) => sum + o.total_price,
    0,
  );

  return {
    activeCustomers: activeRes.count ?? 0,
    deliveriesToday: deliveriesRes.count ?? 0,
    pendingPayments: pendingRes.count ?? 0,
    revenueToday: revenue,
  };
}

async function getChatbotEnabled() {
  const db = createAdminClient();
  const { data } = await db
    .from("settings")
    .select("value")
    .eq("key", "chatbot_enabled")
    .single();
  return data?.value === "true";
}

export default async function HomePage() {
  const [metrics, chatbotEnabled] = await Promise.all([
    getMetrics(),
    getChatbotEnabled(),
  ]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
        <PushSubscribeButton />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Active Customers" value={metrics.activeCustomers} />
        <StatCard label="Deliveries Today" value={metrics.deliveriesToday} />
        <StatCard
          label="Pending Payments"
          value={metrics.pendingPayments}
          highlight={metrics.pendingPayments > 0}
        />
        <StatCard
          label="Revenue Today"
          value={formatIDR(metrics.revenueToday)}
        />
      </div>

      {/* Kill switch */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <h2 className="text-sm font-medium text-gray-900 mb-1">AI Chatbot</h2>
        <p className="text-xs text-gray-500 mb-4">
          Disable to stop all AI responses. Customers will receive a fallback
          message.
        </p>
        <KillSwitch initialEnabled={chatbotEnabled} />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`bg-white rounded-xl border p-4 ${highlight ? "border-orange-200" : "border-gray-100"}`}
    >
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p
        className={`text-2xl font-semibold ${highlight ? "text-orange-600" : "text-gray-900"}`}
      >
        {value}
      </p>
    </div>
  );
}
