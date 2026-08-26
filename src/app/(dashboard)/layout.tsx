export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { AssistantWidget } from "@/components/dashboard/assistant-widget";
import DesktopNav from "@/components/shared/desktop-nav";
import MobileNav from "@/components/shared/mobile-nav";
import QueryProvider from "@/components/shared/query-provider";
import ServiceWorkerRegistrar from "@/components/shared/service-worker-registrar";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { version } from "../../../package.json";

const allNavItems = [
  { href: "/inbox", label: "Inbox", ownerOnly: false },
  { href: "/customers", label: "Customers", ownerOnly: false },
  { href: "/orders", label: "Orders", ownerOnly: false },
  { href: "/deliveries", label: "Deliveries", ownerOnly: false },
  { href: "/payments", label: "Payments", ownerOnly: false },
  { href: "/broadcasts", label: "Broadcasts", ownerOnly: false },
  { href: "/assistant", label: "Assistant", ownerOnly: false },
  { href: "/accounting", label: "Accounting", ownerOnly: true },
  { href: "/activity", label: "Activity", ownerOnly: false },
  { href: "/tasks", label: "Tasks", ownerOnly: false },
  { href: "/handbook", label: "Handbook", ownerOnly: false },
  { href: "/guide", label: "Panduan", ownerOnly: false },
  // /areas shipped without a nav entry and was unreachable for anyone who did
  // not already know the URL — the only editor for the neighborhood names the
  // chatbot matches addresses against.
  { href: "/areas", label: "Areas", ownerOnly: false },
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
      badge:
        href === "/assistant" && pendingBotCount ? pendingBotCount : undefined,
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
        <DesktopNav
          navItems={navItems}
          userEmail={session.email}
          version={`v${version}`}
        />

        {/* Main content */}
        <main className="flex-1 overflow-auto min-h-screen">
          <div className="max-w-6xl mx-auto p-4 md:p-6">{children}</div>
        </main>
      </div>
      <AssistantWidget />
    </QueryProvider>
  );
}
