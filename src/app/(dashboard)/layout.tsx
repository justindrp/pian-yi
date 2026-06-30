export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { version } from "../../../package.json";
import MobileNav from "@/components/shared/mobile-nav";
import QueryProvider from "@/components/shared/query-provider";
import ServiceWorkerRegistrar from "@/components/shared/service-worker-registrar";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { AssistantWidget } from "@/components/dashboard/assistant-widget";

const allNavItems = [
  { href: "/dashboard", label: "Home", ownerOnly: false },
  { href: "/inbox", label: "Inbox", ownerOnly: false },
  { href: "/customers", label: "Customers", ownerOnly: false },
  { href: "/orders", label: "Orders", ownerOnly: false },
  { href: "/deliveries", label: "Deliveries", ownerOnly: false },
  { href: "/payments", label: "Payments", ownerOnly: false },
  { href: "/subcontractors", label: "Subcontractors", ownerOnly: false },
  { href: "/chatbot-training", label: "Chatbot Training", ownerOnly: false },
  { href: "/accounting", label: "Accounting", ownerOnly: true },
  { href: "/reports", label: "Reports", ownerOnly: false },
  { href: "/areas", label: "Areas", ownerOnly: false },
  { href: "/settings", label: "Settings", ownerOnly: false },
  { href: "/broadcasts", label: "Broadcasts", ownerOnly: false },
  { href: "/guide", label: "Panduan", ownerOnly: false },
  { href: "/assistant", label: "Assistant", ownerOnly: false },
];

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionWithRole();
  if (!session) redirect("/login");

  const navItems = allNavItems
    .filter((item) => !item.ownerOnly || session.role === "owner")
    .map(({ href, label }) => ({ href, label }));

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
        <aside className="hidden md:flex w-56 bg-white border-r border-gray-100 flex-col">
          <div className="px-5 py-5 border-b border-gray-100">
            <p className="font-semibold text-gray-900 text-sm">
              Pian Yi Catering
            </p>
            <p className="text-xs text-gray-400 mt-0.5">{session.email}</p>
          </div>
          <nav className="flex-1 p-3">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors mb-0.5"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="p-3 border-t border-gray-100">
            <form action="/api/auth/signout" method="POST">
              <button
                type="submit"
                className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
              >
                Sign out
              </button>
            </form>
            <p className="text-[10px] text-gray-300 px-3 pt-2 font-mono">
              v{version}
            </p>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-auto min-h-screen">
          <div className="max-w-6xl mx-auto p-4 md:p-6">{children}</div>
        </main>
      </div>
      <AssistantWidget />
    </QueryProvider>
  );
}
