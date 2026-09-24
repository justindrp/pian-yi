"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The app's bottom bar. Client-side only to know which tab is current. */
export function BottomNav({ chatHref }: { chatHref: string }) {
  const path = usePathname();
  const onHome = path.startsWith("/menu") || path.startsWith("/area");
  return (
    <nav className="kl-nav" aria-label="Navigasi">
      <Link href="/menu" aria-current={onHome ? "page" : undefined}>
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 10.5L12 4l8 6.5V20h-5.5v-6h-5v6H4z" />
        </svg>
        Beranda
      </Link>
      <Link
        href="/harga"
        aria-current={path.startsWith("/harga") ? "page" : undefined}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
          <path d="M9 8h6M9 12h6" />
        </svg>
        Harga
      </Link>
      <a href={chatHref}>
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z" />
        </svg>
        Chat
      </a>
    </nav>
  );
}
