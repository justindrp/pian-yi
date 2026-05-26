import DashboardMetrics from "@/components/dashboard/dashboard-metrics";
import PushSubscribeButton from "@/components/dashboard/push-subscribe-button";

export default function HomePage() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
        <PushSubscribeButton />
      </div>
      <DashboardMetrics />
    </div>
  );
}
