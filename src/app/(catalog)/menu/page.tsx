import type { Metadata } from "next";
import {
  catalogAreas,
  loadCatalog,
  orderDeadlineLabel,
} from "@/lib/catalog/kitchens";
import { createAdminClient } from "@/lib/supabase/admin";
import { CatalogHome } from "../ui";

export const metadata: Metadata = {
  title: "Pilih dapur — Katerloka",
  description:
    "Katering harian dari beberapa dapur partner. Bandingkan harga per porsi, hari antar dan area, lalu pesan lewat WhatsApp.",
};

export const dynamic = "force-dynamic";

export default async function MenuPage(props: {
  searchParams: Promise<{ f?: string }>;
}) {
  const [kitchens, deadline, { f }] = await Promise.all([
    loadCatalog(createAdminClient()),
    orderDeadlineLabel(),
    props.searchParams,
  ]);

  return (
    <CatalogHome
      kitchens={kitchens}
      areas={catalogAreas(kitchens)}
      area={null}
      filter={f ?? null}
      deadline={deadline}
      minPortions={Math.min(
        ...kitchens.flatMap((k) => k.tiers.map((t) => t.portions)),
      )}
    />
  );
}
