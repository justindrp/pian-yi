import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  type CatalogKitchen,
  chatLink,
  loadCatalog,
  orderDeadlineLabel,
  porsiRange,
  rupiah,
  slugify,
} from "@/lib/catalog/kitchens";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function findKitchen(slug: string): Promise<CatalogKitchen | null> {
  const kitchens = await loadCatalog(createAdminClient());
  return kitchens.find((k) => k.slug === slug) ?? null;
}

export async function generateMetadata(props: {
  params: Promise<{ dapur: string }>;
}): Promise<Metadata> {
  const kitchen = await findKitchen((await props.params).dapur);
  if (!kitchen) return {};
  return {
    title: `${kitchen.nickname} — Katerloka`,
    description: `Katering harian ${kitchen.nickname}: mulai Rp ${rupiah(kitchen.from)} per porsi, antar ${kitchen.daysLabel} ke ${kitchen.areas.join(", ")}.`,
  };
}

const WEEK = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAY_ID = ["", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

export default async function KitchenPage(props: {
  params: Promise<{ dapur: string }>;
}) {
  const kitchen = await findKitchen((await props.params).dapur);
  if (!kitchen) notFound();
  const deadline = await orderDeadlineLabel();

  const prices = kitchen.rungs.map((r) => r.price);
  const dearest = Math.max(...prices);
  const spread = dearest - kitchen.from || 1;
  // Wider bar = dearer portion, as on the landing page.
  const barWidth = (price: number) =>
    `${55 + ((price - kitchen.from) / spread) * 45}%`;

  return (
    <>
      <header className="pl-hero pl-hero--short">
        <div className="pl-shell">
          <span className="pl-eyebrow">Dapur partner</span>
          <h1 className="pl-claim pl-claim--short">
            {kitchen.nickname}
            <em>mulai Rp {rupiah(kitchen.from)}</em>
          </h1>

          <div className="pl-ladder">
            <div className="pl-rung pl-rung--head" aria-hidden="true">
              <span>Porsi</span>
              <span />
              <span>Harga per porsi</span>
            </div>
            {kitchen.rungs.map((rung, i) => (
              <div
                key={rung.min}
                className="pl-rung"
                style={{ animationDelay: `${120 + i * 70}ms` }}
              >
                <span className="pl-rung-porsi">
                  {porsiRange(rung.min, rung.max)}
                </span>
                <span
                  className="pl-bar"
                  aria-hidden="true"
                  style={{
                    width: barWidth(rung.price),
                    animationDelay: `${180 + i * 70}ms`,
                  }}
                />
                <span className="pl-price">
                  {rupiah(rung.price)}
                  <small>/porsi</small>
                </span>
              </div>
            ))}
          </div>

          <a
            className="pl-cta"
            href={chatLink(`Halo, saya mau pesan dari ${kitchen.nickname}`)}
          >
            Pesan dari {kitchen.nickname}
          </a>
          <p className="pl-cta-note">
            Chat WhatsApp — kami hitung totalnya dan kirim rinciannya.
          </p>
        </div>
      </header>

      <main>
        <section className="pl-section">
          <div className="pl-shell">
            <span className="pl-eyebrow">Hari antar</span>
            <ul className="pl-week pl-week--light">
              {WEEK.map((iso) => (
                <li
                  key={iso}
                  className={
                    kitchen.days.includes(iso)
                      ? "pl-day"
                      : "pl-day pl-day--closed"
                  }
                >
                  {WEEKDAY_ID[iso]}
                </li>
              ))}
            </ul>
            <p className="pl-note">
              Pesan, ubah jadwal atau libur sehari paling lambat pukul{" "}
              {deadline} WIB sehari sebelumnya.
            </p>
          </div>
        </section>

        <section className="pl-section pl-section--ruled">
          <div className="pl-shell">
            <span className="pl-eyebrow">Area antar</span>
            <ul className="pl-areas">
              {kitchen.areas.map((area) => (
                <li key={area}>
                  <Link
                    className="pl-badge pl-badge--outline"
                    href={`/area/${slugify(area)}`}
                  >
                    {area}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="pl-note">
              Ongkir, bila ada untuk lokasi kakak, kami konfirmasi lewat chat.
            </p>
          </div>
        </section>

        {(kitchen.sizeM !== null || kitchen.noRiceOff > 0) && (
          <section className="pl-section pl-section--ruled">
            <div className="pl-shell">
              <span className="pl-eyebrow">Pilihan</span>
              <dl className="pl-options">
                {kitchen.sizeM !== null && (
                  <div>
                    <dt>Size M</dt>
                    <dd className="pl-num">
                      + Rp {rupiah(kitchen.sizeM)} per porsi
                    </dd>
                  </div>
                )}
                {kitchen.noRiceOff > 0 && (
                  <div>
                    <dt>Tanpa nasi</dt>
                    <dd className="pl-num">
                      − Rp {rupiah(kitchen.noRiceOff)} per porsi
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </section>
        )}

        <section className="pl-section pl-section--ruled">
          <div className="pl-shell">
            <span className="pl-eyebrow">Menu</span>
            <p className="pl-note">
              Menu berganti tiap minggu. Minta menu minggu ini lewat{" "}
              <a
                href={chatLink(
                  `Halo, boleh lihat menu ${kitchen.nickname} minggu ini?`,
                )}
              >
                chat
              </a>
              .
            </p>
          </div>
        </section>
      </main>
    </>
  );
}
