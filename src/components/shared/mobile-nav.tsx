"use client";

import Link from "next/link";
import { useState } from "react";

interface NavItem {
  href: string;
  label: string;
}

interface MobileNavProps {
  navItems: NavItem[];
  userEmail: string | undefined;
  version: string;
}

export default function MobileNav({ navItems, userEmail, version }: MobileNavProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Top bar */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-gray-100">
        <p className="font-semibold text-gray-900 text-sm">Pian Yi Catering</p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="p-2 rounded-lg text-gray-500 hover:bg-gray-50"
          aria-label="Open menu"
        >
          <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} role="img" aria-label="Open menu">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </header>

      {/* Overlay */}
      {open && (
        <button
          type="button"
          className="md:hidden fixed inset-0 z-40 bg-black/30"
          onClick={() => setOpen(false)}
          aria-label="Close menu"
        />
      )}

      {/* Drawer */}
      <div
        className={`md:hidden fixed inset-y-0 left-0 z-50 w-64 bg-white flex flex-col transform transition-transform duration-200 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="px-5 py-5 border-b border-gray-100 flex items-center justify-between">
          <div>
            <p className="font-semibold text-gray-900 text-sm">Pian Yi Catering</p>
            <p className="text-xs text-gray-400 mt-0.5">{userEmail}</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1 rounded-lg text-gray-400 hover:bg-gray-50"
            aria-label="Close menu"
          >
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} role="img" aria-label="Close menu">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <nav className="flex-1 p-3 overflow-y-auto">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="flex items-center px-3 py-2.5 rounded-lg text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors mb-0.5"
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
          <p className="text-[10px] text-gray-300 px-3 pt-2 font-mono">{version}</p>
        </div>
      </div>
    </>
  );
}
