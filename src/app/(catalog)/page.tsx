import type { Metadata } from "next";
import {
  ADDRESS,
  BRAND,
  catalogAreas,
  LEGAL_NAME,
  loadCatalog,
  orderDeadlineLabel,
  rupiah,
  WA_NUMBER,
} from "@/lib/catalog/kitchens";
import { daysLabel } from "@/lib/subcontractors/days";
import { createAdminClient } from "@/lib/supabase/admin";
import { CatalogHome } from "./ui";

export const dynamic = "force-dynamic";

// Price and days come from the rows, never written in: the old landing page
// once read "Senin–Sabtu" while one kitchen delivered seven days.
function describe(from: number, days: string): string {
  return `Katering makan harian untuk rumah dan kantor, dari beberapa dapur partner. Mulai Rp ${rupiah(from)} per porsi, diantar ${days}. Bandingkan harga, lalu pesan lewat WhatsApp.`;
}

const openDays = (kitchens: { days: number[] }[]) =>
  [...new Set(kitchens.flatMap((k) => k.days))].sort((a, b) => a - b);

export async function generateMetadata(): Promise<Metadata> {
  const kitchens = await loadCatalog(createAdminClient());
  return {
    title: `${BRAND} — Katering Harian`,
    description: describe(
      Math.min(...kitchens.map((k) => k.from)),
      daysLabel(openDays(kitchens)),
    ),
    alternates: { canonical: "/" },
  };
}

// schema.org wants English day names; index is the ISO weekday.
const WEEKDAY_EN = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/**
 * katerloka.com itself: the kitchen list. It replaced the single-ladder
 * landing page on 2026-09-24. The legal name, NIB and registered address that
 * Meta business verification matches against stay in the footer and in the
 * JSON-LD below.
 */
export default async function HomePage(props: {
  searchParams: Promise<{ f?: string }>;
}) {
  const [kitchens, deadline, { f }] = await Promise.all([
    loadCatalog(createAdminClient()),
    orderDeadlineLabel(),
    props.searchParams,
  ]);
  const areas = catalogAreas(kitchens);
  const prices = kitchens.flatMap((k) =>
    k.tiers.map((t) => t.price_per_portion),
  );
  const days = openDays(kitchens);

  const schema = {
    "@context": "https://schema.org",
    "@type": ["LocalBusiness", "FoodEstablishment"],
    name: BRAND,
    legalName: LEGAL_NAME,
    description: describe(Math.min(...prices), daysLabel(days)),
    telephone: `+${WA_NUMBER}`,
    address: {
      "@type": "PostalAddress",
      streetAddress: ADDRESS.street,
      addressLocality: ADDRESS.city,
      addressRegion: ADDRESS.region,
      postalCode: ADDRESS.postalCode,
      addressCountry: ADDRESS.country,
    },
    areaServed: areas.map((name) => ({ "@type": "Place", name })),
    servesCuisine: "Indonesian",
    priceRange: `Rp${rupiah(Math.min(...prices))}–Rp${rupiah(Math.max(...prices))}`,
    openingHoursSpecification: [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: days.map((iso) => WEEKDAY_EN[iso]),
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD assembled from our own database rows and constants, never from user input
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
      />
      <CatalogHome
        kitchens={kitchens}
        areas={areas}
        area={null}
        filter={f ?? null}
        deadline={deadline}
        minPortions={Math.min(
          ...kitchens.flatMap((k) => k.tiers.map((t) => t.portions)),
        )}
      />
    </>
  );
}
