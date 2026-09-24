import type { Metadata } from "next";
import Link from "next/link";
import {
  catalogAreas,
  chatLink,
  loadCatalog,
  slugify,
} from "@/lib/catalog/kitchens";
import { createAdminClient } from "@/lib/supabase/admin";
import { KitchenCard } from "../kitchen-card";

export const metadata: Metadata = {
  title: "Pilih dapur — Katerloka",
  description:
    "Katering harian dari beberapa dapur partner. Bandingkan harga per porsi, hari antar dan area, lalu pesan lewat WhatsApp.",
};

export const dynamic = "force-dynamic";

export default async function MenuPage() {
  const kitchens = await loadCatalog(createAdminClient());
  const areas = catalogAreas(kitchens);

  return (
    <>
      <header className="pl-hero pl-hero--short">
        <div className="pl-shell">
          <h1 className="pl-claim pl-claim--short">
            Satu chat,
            <em>{kitchens.length} dapur.</em>
          </h1>
          <p className="pl-lede">
            Tiap dapur punya menu, harga dan hari antarnya sendiri. Pilih area
            kakak dulu — daftar dapurnya langsung menyempit.
          </p>
          <ul className="pl-areas pl-areas--hero">
            {areas.map((area) => (
              <li key={area}>
                <Link className="pl-badge" href={`/area/${slugify(area)}`}>
                  {area}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </header>

      <main className="pl-section">
        <div className="pl-shell">
          <span className="pl-eyebrow">Semua dapur</span>
          <ul className="pl-kitchens">
            {kitchens.map((k) => (
              <KitchenCard key={k.slug} kitchen={k} />
            ))}
          </ul>
          <p className="pl-note">
            Harga per porsi, makin banyak makin murah — lihat{" "}
            <Link href="/harga">perbandingan harga</Link>. Area kakak belum ada?{" "}
            <a
              href={chatLink(
                "Halo, area saya belum ada di daftar. Bisa antar ke sini?",
              )}
            >
              Chat kami
            </a>
            .
          </p>
        </div>
      </main>
    </>
  );
}
