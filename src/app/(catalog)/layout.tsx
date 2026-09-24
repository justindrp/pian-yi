import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { notFound } from "next/navigation";
import { chatLink } from "@/lib/catalog/kitchens";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { BottomNav } from "./nav";
import "./catalog.css";

const font = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--kl-font",
  display: "swap",
});

// Not indexed while it is a preview: see the gate below.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * The public catalog (docs/ORDER_SITE.md, phase 4), built ahead of its launch
 * and laid out as a food-delivery app.
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
    <div className={`kl ${font.variable}`}>
      <div className="kl-app">
        {children}
        <BottomNav chatHref={chatLink()} />
      </div>
    </div>
  );
}
