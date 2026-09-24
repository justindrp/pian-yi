import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  type CatalogKitchen,
  catalogAreas,
  loadCatalog,
  orderDeadlineLabel,
  slugify,
} from "@/lib/catalog/kitchens";
import { createAdminClient } from "@/lib/supabase/admin";
import { CatalogHome } from "../../ui";

export const dynamic = "force-dynamic";

/**
 * The area named by a slug, and every kitchen shown. An area no active kitchen
 * serves is a 404, not an empty page: coverage is the union of the active
 * kitchens' own `delivery_areas`, so deactivating the last kitchen in an area
 * removes its page with it.
 */
async function findArea(
  slug: string,
): Promise<{ area: string; all: CatalogKitchen[] } | null> {
  const all = await loadCatalog(createAdminClient());
  const area = catalogAreas(all).find((a) => slugify(a) === slug);
  return area ? { area, all } : null;
}

export async function generateMetadata(props: {
  params: Promise<{ area: string }>;
}): Promise<Metadata> {
  const found = await findArea((await props.params).area);
  if (!found) return {};
  const n = found.all.filter((k) => k.areas.includes(found.area)).length;
  return {
    title: `Katering harian ${found.area} — Katerloka`,
    description: `${n} dapur partner antar ke ${found.area}. Bandingkan harga per porsi dan hari antar, lalu pesan lewat WhatsApp.`,
  };
}

export default async function AreaPage(props: {
  params: Promise<{ area: string }>;
  searchParams: Promise<{ f?: string }>;
}) {
  const [found, deadline, { f }] = await Promise.all([
    props.params.then((p) => findArea(p.area)),
    orderDeadlineLabel(),
    props.searchParams,
  ]);
  if (!found) notFound();
  const { area, all } = found;

  return (
    <CatalogHome
      kitchens={all}
      areas={catalogAreas(all)}
      area={area}
      filter={f ?? null}
      deadline={deadline}
      minPortions={Math.min(
        ...all.flatMap((k) => k.tiers.map((t) => t.portions)),
      )}
    />
  );
}
