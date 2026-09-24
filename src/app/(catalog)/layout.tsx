import type { Metadata } from "next";
import { Nunito, Poppins } from "next/font/google";
import Link from "next/link";
import { notFound } from "next/navigation";
import { chatLink, WA_DISPLAY } from "@/lib/catalog/kitchens";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import "../landing.css";
import "./catalog.css";

// The same two faces as the landing page, so the catalog reads as one brand.
const display = Poppins({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
  variable: "--pl-font-display",
  display: "swap",
});

const body = Nunito({
  subsets: ["latin"],
  variable: "--pl-font-body",
  display: "swap",
});

const BRAND = "Katerloka";

// Not indexed while it is a preview: see the gate below.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * The public catalog (docs/ORDER_SITE.md, phase 4), built ahead of its launch.
 *
 * **Signed-in admins only until launch.** Two things stand between these pages
 * and the public, both recorded in "Open before this starts": the wholesale
 * renegotiation (a public ladder makes our margin one click to compute for our
 * own kitchens) and a menu identity per kitchen (a nickname alone gives a
 * customer no basis to choose). Launching is deleting this check and the
 * `robots` line above.
 */
export default async function CatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await getSessionWithRole())) notFound();

  return (
    <div className={`pl ${display.variable} ${body.variable}`}>
      <nav className="pl-topbar">
        <div className="pl-shell pl-topbar-inner">
          <Link href="/menu" className="pl-mark-name">
            {BRAND}
          </Link>
          <div className="pl-topbar-links">
            <Link href="/menu">Dapur</Link>
            <Link href="/harga">Harga</Link>
          </div>
        </div>
      </nav>

      {children}

      <footer className="pl-foot">
        <div className="pl-shell">
          <nav className="pl-foot-links">
            <a href={chatLink()}>WhatsApp {WA_DISPLAY}</a>
            <a href="/privacy">Kebijakan Privasi</a>
            <a href="/terms">Syarat &amp; Ketentuan</a>
          </nav>
          <small>
            © {new Date().getFullYear()} {BRAND}
          </small>
        </div>
      </footer>
    </div>
  );
}
