import type { Metadata } from "next";
import { Nunito, Poppins } from "next/font/google";
import Image from "next/image";
import { activeDeliveryAreas } from "@/lib/subcontractors/areas";
import { createAdminClient } from "@/lib/supabase/admin";
import "./landing.css";

// Both faces come from the Instagram post design system, so the site and the
// ads read as one brand. Poppins carries headings, badges and every figure;
// Nunito carries running text.
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

// The public number customers message. Not the phone_number_id — that is an
// internal Meta handle and means nothing in a wa.me link.
const WA_NUMBER = "6285111214390";
const WA_DISPLAY = "+62 851-1121-4390";
const WA_LINK = `https://wa.me/${WA_NUMBER}`;

const LEGAL_NAME = "Pian Yi Catering";
const NIB = "2307250135661";
const ADDRESS = {
  street:
    "Jl. Palm Kuning IV Blok BE/06 Sekt.1-3, RT 002/RW 007, Kel. Rawabuntu, Kec. Serpong",
  city: "Kota Tangerang Selatan",
  region: "Banten",
  postalCode: "15318",
  country: "ID",
};

export const metadata: Metadata = {
  title: "Katering Harian Tangerang Selatan — Pian Yi Catering",
  description:
    "Katering makan harian untuk rumah dan kantor di Tangerang Selatan. Mulai Rp 25.000 per porsi, diantar Senin–Sabtu. Pesan lewat WhatsApp, tanpa aplikasi.",
  alternates: { canonical: "/" },
};

// Pricing, coverage and the menu image are read live, so the page must not be
// baked once at build time. Ten minutes is short enough that a price change
// lands the same morning it is made.
export const revalidate = 600;

type Tier = { portions: number; price_per_portion: number };
type Rung = { price: number; min: number; max: number };

/**
 * Collapse the twelve pricing tiers into the handful of prices that actually
 * exist. Five, six, ten and twelve portions are four rows in the database but
 * only two prices, and a customer comparing caterers wants the prices — the
 * per-portion granularity is noise on a page whose whole argument is the shape
 * of the ladder. Derived, never written down, so a new tier appears by itself.
 */
function toRungs(tiers: Tier[]): Rung[] {
  const rungs: Rung[] = [];
  for (const tier of [...tiers].sort((a, b) => a.portions - b.portions)) {
    const last = rungs.at(-1);
    if (last && last.price === tier.price_per_portion) {
      last.max = tier.portions;
    } else {
      rungs.push({
        price: tier.price_per_portion,
        min: tier.portions,
        max: tier.portions,
      });
    }
  }
  return rungs;
}

async function loadContent() {
  const db = createAdminClient();
  const [tiersRes, settingsRes, areas] = await Promise.all([
    db
      .from("pricing_tiers")
      .select("portions, price_per_portion")
      .is("subcontractor_id", null),
    db
      .from("settings")
      .select("key, value")
      .in("key", ["price_list_image_url", "instagram_handle"]),
    activeDeliveryAreas(db),
  ]);

  const settings: Record<string, string> = {};
  for (const row of settingsRes.data ?? []) settings[row.key] = row.value;

  return {
    rungs: toRungs((tiersRes.data ?? []) as Tier[]),
    priceListImage: settings.price_list_image_url ?? null,
    instagram: settings.instagram_handle ?? null,
    areas,
  };
}

const rupiah = (n: number) => n.toLocaleString("id-ID");

export default async function LandingPage() {
  const { rungs, priceListImage, instagram, areas } = await loadContent();

  const prices = rungs.map((r) => r.price);
  const dearest = Math.max(...prices);
  const cheapest = Math.min(...prices);
  const spread = dearest - cheapest || 1;
  // Wider bar = dearer portion, so the ladder narrows as it descends and the
  // headline claim is demonstrated rather than asserted.
  const barWidth = (price: number) =>
    `${55 + ((price - cheapest) / spread) * 45}%`;

  const schema = {
    "@context": "https://schema.org",
    "@type": ["LocalBusiness", "FoodEstablishment"],
    name: LEGAL_NAME,
    description: metadata.description,
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
    priceRange: `Rp${rupiah(cheapest)}–Rp${rupiah(dearest)}`,
    openingHoursSpecification: [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
        ],
      },
    ],
  };

  return (
    <div className={`pl ${display.variable} ${body.variable}`}>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD assembled from our own database rows and constants, never from user input
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
      />

      <header className="pl-hero">
        <div className="pl-shell">
          <div className="pl-mark">
            <span className="pl-mark-name">Pian Yi Catering</span>
            <span className="pl-mark-tag">
              Tangerang Selatan
              <br />
              Senin–Sabtu
            </span>
          </div>

          <h1 className="pl-claim">
            Makin banyak,
            <em>makin murah.</em>
          </h1>

          <p className="pl-lede">
            Katering makan harian untuk rumah dan kantor di{" "}
            {areas.slice(0, -1).join(", ")}
            {areas.length > 1 ? ` dan ${areas.at(-1)}` : areas[0]}. Satu harga
            per porsi, sudah termasuk pengiriman.
          </p>

          <div className="pl-ladder">
            <div className="pl-rung pl-rung--head" aria-hidden="true">
              <span>Porsi</span>
              <span />
              <span>Harga per porsi</span>
            </div>
            {rungs.map((rung, i) => (
              <div
                key={rung.price}
                className="pl-rung"
                style={{ animationDelay: `${120 + i * 70}ms` }}
              >
                <span className="pl-rung-porsi">
                  {rung.min === rung.max
                    ? `${rung.min} porsi`
                    : `${rung.min}–${rung.max}`}
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

          <p className="pl-badge pl-badge--hemat">
            Hemat Rp {rupiah(dearest - cheapest)} per porsi
          </p>

          <div>
            <a className="pl-cta" href={WA_LINK}>
              Pesan lewat WhatsApp
            </a>
            <p className="pl-cta-note">{WA_DISPLAY}</p>
          </div>
        </div>
      </header>

      <main>
        <section className="pl-section">
          <div className="pl-shell">
            <span className="pl-eyebrow">Cara pesan</span>
            <h2 className="pl-h2">Tiga langkah, semuanya di WhatsApp</h2>
            <ol className="pl-steps">
              <li className="pl-step">
                <h3>Chat kami</h3>
                <p>
                  Kirim pesan ke nomor kami. Tanpa aplikasi, tanpa daftar akun.
                </p>
              </li>
              <li className="pl-step">
                <h3>Pilih paket</h3>
                <p>
                  Sebutkan jumlah porsi, jam antar, dan alamat. Kami hitung
                  totalnya dan kirim rinciannya.
                </p>
              </li>
              <li className="pl-step">
                <h3>Kami antar</h3>
                <p>
                  Makanan datang sesuai jadwal kakak. Mau libur sehari? Cukup
                  kabari lewat chat.
                </p>
              </li>
            </ol>
          </div>
        </section>

        <section className="pl-section pl-section--red">
          <div className="pl-shell">
            <span className="pl-eyebrow">Jadwal &amp; area</span>
            <h2 className="pl-h2">Kapan dan ke mana kami antar</h2>
            <ul className="pl-week">
              {["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"].map(
                (day) => (
                  <li key={day} className="pl-day">
                    {day}
                  </li>
                ),
              )}
              <li className="pl-day pl-day--closed">Minggu</li>
            </ul>
            <div className="pl-cutoff">
              <span className="pl-cutoff-time pl-num">16.00</span>
              <p>
                Batas pesan untuk besok, waktu WIB. Perubahan jadwal, ganti
                alamat, dan libur sehari ikut batas yang sama. Kami tutup hari
                Minggu dan libur nasional.
              </p>
            </div>
            <ul className="pl-areas">
              {areas.map((area) => (
                <li key={area} className="pl-badge">
                  {area}
                </li>
              ))}
            </ul>
            <p className="pl-note">
              Belum ada area kakak di daftar ini? Chat kami — cakupan pengiriman
              kami bertambah dari waktu ke waktu.
            </p>
          </div>
        </section>

        {priceListImage && (
          <section className="pl-section pl-section--ruled">
            <div className="pl-shell">
              <span className="pl-eyebrow">Pilihan paket</span>
              <Image
                className="pl-menu-img"
                src={priceListImage}
                alt="Daftar paket dan pilihan menu Pian Yi Catering"
                width={1080}
                height={1350}
                sizes="(max-width: 68rem) 100vw, 68rem"
              />
            </div>
          </section>
        )}

        <section className="pl-section pl-section--ruled">
          <div className="pl-shell">
            <span className="pl-eyebrow">Identitas usaha</span>
            <dl className="pl-identity">
              <div>
                <dt>Nama badan usaha</dt>
                <dd>{LEGAL_NAME}</dd>
                <dt>Nomor Induk Berusaha</dt>
                <dd className="pl-num">{NIB}</dd>
              </div>
              <div>
                <dt>Alamat terdaftar</dt>
                <dd>
                  {ADDRESS.street}, {ADDRESS.city}, {ADDRESS.region}{" "}
                  {ADDRESS.postalCode}
                </dd>
              </div>
              <div>
                <dt>WhatsApp</dt>
                <dd>
                  <a href={WA_LINK}>{WA_DISPLAY}</a>
                </dd>
                <dt>Email</dt>
                <dd>
                  <a href="mailto:drpramadyo@gmail.com">drpramadyo@gmail.com</a>
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </main>

      <footer className="pl-foot">
        <div className="pl-shell">
          <nav className="pl-foot-links">
            <a href="/privacy">Kebijakan Privasi</a>
            <a href="/terms">Syarat &amp; Ketentuan</a>
            <a href="/data-deletion">Penghapusan Data</a>
            {instagram && (
              <a href={`https://instagram.com/${instagram.replace(/^@/, "")}`}>
                Instagram
              </a>
            )}
          </nav>
          <small>
            © {new Date().getFullYear()} {LEGAL_NAME} · NIB {NIB} ·{" "}
            {ADDRESS.city}, {ADDRESS.region}
          </small>
        </div>
      </footer>
    </div>
  );
}
