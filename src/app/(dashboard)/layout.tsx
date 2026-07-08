export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { version } from "../../../package.json";
import MobileNav from "@/components/shared/mobile-nav";
import DesktopNav from "@/components/shared/desktop-nav";
import QueryProvider from "@/components/shared/query-provider";
import ServiceWorkerRegistrar from "@/components/shared/service-worker-registrar";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { AssistantWidget } from "@/components/dashboard/assistant-widget";
import { createAdminClient } from "@/lib/supabase/admin";

const allNavItems = [
  { href: "/inbox", label: "Inbox", ownerOnly: false },
  { href: "/customers", label: "Customers", ownerOnly: false },
  { href: "/orders", label: "Orders", ownerOnly: false },
  { href: "/deliveries", label: "Deliveries", ownerOnly: false },
  { href: "/payments", label: "Payments", ownerOnly: false },
  { href: "/broadcasts", label: "Broadcasts", ownerOnly: false },
  { href: "/assistant", label: "Assistant", ownerOnly: false },
  { href: "/accounting", label: "Accounting", ownerOnly: true },
  { href: "/settings", label: "Settings", ownerOnly: false },
];

type NavItem = { href: string; label: string; badge?: number };

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionWithRole();
  if (!session) redirect("/login");

  const db = createAdminClient();
  const { count: pendingBotCount } = await db
    .from("customer_flags")
    .select("*", { count: "exact", head: true })
    .eq("pending_bot_response", true);

  const navItems: NavItem[] = allNavItems
    .filter((item) => !item.ownerOnly || session.role === "owner")
    .map(({ href, label }) => ({
      href,
      label,
      badge: href === "/assistant" && (pendingBotCount ?? 0) > 0 ? pendingBotCount! : undefined,
    }));

  return (
    <QueryProvider>
      <ServiceWorkerRegistrar />
      <MobileNav
        navItems={navItems}
        userEmail={session.email}
        version={`v${version}`}
      />
      <div className="min-h-screen bg-gray-50 flex">
        {/* Sidebar — desktop only */}
        <DesktopNav navItems={navItems} userEmail={session.email} version={`v${version}`} />

        {/* Main content */}
        <main className="flex-1 overflow-auto min-h-screen">
          <div className="max-w-6xl mx-auto p-4 md:p-6">{children}</div>
        </main>
      </div>
      <AssistantWidget />
    </QueryProvider>
  );
}
