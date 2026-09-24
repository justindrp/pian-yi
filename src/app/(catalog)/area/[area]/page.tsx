import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  type CatalogKitchen,
  catalogAreas,
  chatLink,
  loadCatalog,
  slugify,
} from "@/lib/catalog/kitchens";
import { createAdminClient } from "@/lib/supabase/admin";
import { KitchenCard } from "../../kitchen-card";

export const dynamic = "force-dynamic";

/**
 * The area named by a slug, and the kitchens serving it. An area no active
 * kitchen serves is a 404, not an empty page: coverage is the union of the
 * active kitchens' own `delivery_areas`, so deactivating the last kitchen in an
 * area removes its page with it.
 */
async function findArea(
  slug: string,
): Promise<{ area: string; kitchens: CatalogKitchen[] } | null> {
  const all = await loadCatalog(createAdminClient());
  const area = catalogAreas(all).find((a) => slugify(a) === slug);
  if (!area) return null;
  return { area, kitchens: all.filter((k) => k.areas.includes(area)) };
}

export async function generateMetadata(props: {
  params: Promise<{ area: string }>;
}): Promise<Metadata> {
  const found = await findArea((await props.params).area);
  if (!found) return {};
  return {
    title: `Katering harian ${found.area} — Katerloka`,
    description: `${found.kitchens.length} dapur partner antar ke ${found.area}. Bandingkan harga per porsi dan hari antar, lalu pesan lewat WhatsApp.`,
  };
}

export default async function AreaPage(props: {
  params: Promise<{ area: string }>;
}) {
  const found = await findArea((await props.params).area);
  if (!found) notFound();
  const { area, kitchens } = found;

  return (
    <>
      <header className="pl-hero pl-hero--short">
        <div className="pl-shell">
          <span className="pl-eyebrow">Area antar</span>
          <h1 className="pl-claim pl-claim--short">
            {area}
            <em>{kitchens.length} dapur antar ke sini</em>
          </h1>
          <a
            className="pl-cta"
            href={chatLink(`Halo, saya di ${area}, mau pesan katering`)}
          >
            Tanya lewat WhatsApp
          </a>
        </div>
      </header>

      <main className="pl-section">
        <div className="pl-shell">
          <ul className="pl-kitchens">
            {kitchens.map((k) => (
              <KitchenCard key={k.slug} kitchen={k} />
            ))}
          </ul>
          <p className="pl-note">
            Bukan area kakak? <Link href="/menu">Lihat semua dapur</Link>.
          </p>
        </div>
      </main>
    </>
  );
}
