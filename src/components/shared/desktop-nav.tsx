"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  MessageSquare,
  Users,
  ClipboardList,
  Truck,
  CreditCard,
  Megaphone,
  Sparkles,
  BookOpen,
  Settings,
  HelpCircle,
  LogOut,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  badge?: number;
}

interface DesktopNavProps {
  navItems: NavItem[];
  userEmail: string | undefined;
  version: string;
}

const NAV_ICONS: Record<string, React.ElementType> = {
  "/inbox": MessageSquare,
  "/customers": Users,
  "/orders": ClipboardList,
  "/deliveries": Truck,
  "/payments": CreditCard,
  "/broadcasts": Megaphone,
  "/assistant": Sparkles,
  "/accounting": BookOpen,
  "/settings": Settings,
};

export default function DesktopNav({ navItems, userEmail, version }: DesktopNavProps) {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex w-56 bg-white border-r border-gray-100 flex-col">
      <div className="px-5 py-5 border-b border-gray-100">
        <Link href="/dashboard" className="font-semibold text-gray-900 text-sm hover:text-gray-700 transition-colors">
          Pian Yi Catering
        </Link>
        <p className="text-xs text-gray-400 mt-0.5">{userEmail}</p>
      </div>
      <nav className="flex-1 p-3 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = NAV_ICONS[item.href];
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-sm transition-colors mb-0.5 border-l-2 ${
                active
                  ? "border-amber-500 bg-amber-50 text-amber-700 font-medium"
                  : "border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              }`}
            >
              {Icon && (
                <Icon
                  size={14}
                  className={active ? "text-amber-600" : "text-gray-400"}
                />
              )}
              <span className="flex-1">{item.label}</span>
              {item.badge ? (
                <span className="text-xs bg-amber-100 text-amber-700 font-medium rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center">
                  {item.badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div className="p-3 border-t border-gray-100">
        <Link
          href="/guide"
          className="flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors border-l-2 border-transparent mb-0.5"
        >
          <HelpCircle size={14} className="text-gray-400" />
          <span>Panduan</span>
        </Link>
        <form action="/api/auth/signout" method="POST">
          <button
            type="submit"
            className="w-full flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors border-l-2 border-transparent"
          >
            <LogOut size={14} className="text-gray-400" />
            <span>Sign out</span>
          </button>
        </form>
        <p className="text-[10px] text-gray-300 px-3 pt-2 font-mono">{version}</p>
      </div>
    </aside>
  );
}
