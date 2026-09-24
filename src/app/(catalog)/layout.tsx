import { Plus_Jakarta_Sans } from "next/font/google";
import { chatLink } from "@/lib/catalog/kitchens";
import { BottomNav } from "./nav";
import "./catalog.css";

const font = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--kl-font",
  display: "swap",
});

/**
 * The public catalog (docs/ORDER_SITE.md, phase 4), laid out as a
 * food-delivery app. Public since 2026-09-24: katerloka.com itself is its home
 * screen. Nothing here may print a kitchen's real name — `loadCatalog()` never
 * hands one to a page.
 */
export default function CatalogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`kl ${font.variable}`}>
      <div className="kl-app">
        {children}
        <BottomNav chatHref={chatLink()} />
      </div>
    </div>
  );
}
