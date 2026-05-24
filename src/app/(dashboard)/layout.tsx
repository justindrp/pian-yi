import Link from "next/link";
import { redirect } from "next/navigation";
import QueryProvider from "@/components/shared/query-provider";
import ServiceWorkerRegistrar from "@/components/shared/service-worker-registrar";
import { createClient } from "@/lib/supabase/server";

const navItems = [
  { href: "/dashboard", label: "Home" },
  { href: "/inbox", label: "Inbox" },
  { href: "/customers", label: "Customers" },
  { href: "/orders", label: "Orders" },
  { href: "/deliveries", label: "Deliveries" },
  { href: "/payments", label: "Payments" },
  { href: "/subcontractors", label: "Subcontractors" },
  { href: "/chatbot-training", label: "Chatbot Training" },
  { href: "/reports", label: "Reports" },
  { href: "/settings", label: "Settings" },
];

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return (
    <QueryProvider>
      <ServiceWorkerRegistrar />
      <div className="min-h-screen bg-gray-50 flex">
        {/* Sidebar */}
        <aside className="w-56 bg-white border-r border-gray-100 flex flex-col">
          <div className="px-5 py-5 border-b border-gray-100">
            <p className="font-semibold text-gray-900 text-sm">
              Pian Yi Catering
            </p>
            <p className="text-xs text-gray-400 mt-0.5">{user.email}</p>
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
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-auto">
          <div className="max-w-6xl mx-auto p-6">{children}</div>
        </main>
      </div>
    </QueryProvider>
  );
}
