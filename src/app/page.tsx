import type { Metadata } from "next";
import Image from "next/image";
import { activeDeliveryAreas } from "@/lib/subcontractors/areas";
import { createAdminClient } from "@/lib/supabase/admin";

// The public number customers message. Not the phone_number_id — that is an
// internal Meta handle and means nothing in a wa.me link.
const WA_NUMBER = "6285111214390";
const WA_DISPLAY = "+62 851-1121-4390";
const WA_LINK = `https://wa.me/${WA_NUMBER}`;

export const metadata: Metadata = {
  title: "Pian Yi Catering — Katering Harian Tangerang Selatan",
  description:
    "Katering makan siang dan malam harian di Tangerang Selatan. Pesan lewat WhatsApp, antar Senin–Sabtu.",
};

// The page reads pricing, coverage and the menu image from the database, so it
// must not be baked at build time. Ten minutes is short enough that a price
// change lands the same morning it is made.
export const revalidate = 600;

type Tier = { portions: number; price_per_portion: number };

async function loadContent() {
  const db = createAdminClient();
  const [tiersRes, settingsRes, areas] = await Promise.all([
    db
      .from("pricing_tiers")
      .select("portions, price_per_portion")
      .order("portions"),
    db.from("settings").select("key, value").in("key", ["price_list_image_url", "instagram_handle"]),
    activeDeliveryAreas(db),
  ]);

  const settings: Record<string, string> = {};
  for (const row of settingsRes.data ?? []) settings[row.key] = row.value;

  return {
    tiers: (tiersRes.data ?? []) as Tier[],
    priceListImage: settings.price_list_image_url ?? null,
    instagram: settings.instagram_handle ?? null,
    areas,
  };
}

const rupiah = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;

export default async function LandingPage() {
  const { tiers, priceListImage, instagram, areas } = await loadContent();

  return (
    <main className="font-sans text-gray-800">
      {/* Hero */}
      <section className="bg-emerald-50 border-b border-emerald-100">
        <div className="max-w-3xl mx-auto px-6 py-16 text-center">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Pian Yi Catering
          </h1>
          <p className="mt-3 text-base text-gray-600">
            Katering makan harian di Tangerang Selatan. Masakan rumahan, diantar
            Senin sampai Sabtu.
          </p>
          <a
            href={WA_LINK}
            className="inline-block mt-8 rounded-lg bg-emerald-600 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            Pesan lewat WhatsApp
          </a>
          <p className="mt-3 text-xs text-gray-500">{WA_DISPLAY}</p>
        </div>
      </section>

      {/* Cara pesan */}
      <section className="max-w-3xl mx-auto px-6 py-14">
        <h2 className="text-lg font-semibold mb-6">Cara pesan</h2>
        <ol className="grid gap-5 sm:grid-cols-3">
          {[
            ["1. Chat WhatsApp", "Kirim pesan ke nomor kami. Tidak perlu aplikasi atau pendaftaran."],
            ["2. Pilih paket", "Tentukan jumlah porsi, jam antar, dan alamat pengiriman."],
            ["3. Kami antar", "Makanan diantar Senin–Sabtu sesuai jadwal yang kakak pilih."],
          ].map(([title, body]) => (
            <li key={title} className="rounded-lg border border-gray-200 p-4">
              <h3 className="text-sm font-semibold mb-1">{title}</h3>
              <p className="text-sm leading-relaxed text-gray-600">{body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm leading-relaxed text-gray-600">
          Pemesanan, perubahan, dan pembatalan untuk besok ditutup pukul 16.00
          WIB hari sebelumnya. Minggu dan hari libur nasional kami tutup.
        </p>
      </section>

      {/* Harga */}
      <section className="bg-gray-50 border-y border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-14">
          <h2 className="text-lg font-semibold mb-2">Harga</h2>
          <p className="text-sm text-gray-600 mb-6">
            Makin banyak porsi, makin murah per porsinya. Harga sudah termasuk
            pengiriman ke area layanan kami.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left border-b border-gray-300">
                  <th className="py-2 pr-4 font-semibold">Porsi</th>
                  <th className="py-2 pr-4 font-semibold">Per porsi</th>
                  <th className="py-2 font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((t) => (
                  <tr key={t.portions} className="border-b border-gray-200">
                    <td className="py-2 pr-4">{t.portions}</td>
                    <td className="py-2 pr-4">{rupiah(t.price_per_portion)}</td>
                    <td className="py-2">
                      {rupiah(t.portions * t.price_per_portion)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-gray-500">
            Untuk kebutuhan kantor atau acara dengan jumlah besar, hubungi kami
            lewat WhatsApp untuk penawaran khusus.
          </p>
        </div>
      </section>

      {/* Menu */}
      {priceListImage && (
        <section className="max-w-3xl mx-auto px-6 py-14">
          <h2 className="text-lg font-semibold mb-6">Pilihan paket</h2>
          <Image
            src={priceListImage}
            alt="Daftar paket dan harga Pian Yi Catering"
            width={1080}
            height={1350}
            sizes="(max-width: 768px) 100vw, 768px"
            className="w-full h-auto rounded-lg border border-gray-200"
          />
        </section>
      )}

      {/* Area */}
      <section className="bg-gray-50 border-y border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-14">
          <h2 className="text-lg font-semibold mb-2">Area pengiriman</h2>
          <p className="text-sm text-gray-600 mb-4">
            Saat ini kami mengantar ke area berikut:
          </p>
          <ul className="flex flex-wrap gap-2">
            {areas.map((area) => (
              <li
                key={area}
                className="rounded-full border border-gray-300 bg-white px-3 py-1 text-sm"
              >
                {area}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-gray-500">
            Belum melihat area kakak? Chat kami — cakupan pengiriman kami
            bertambah dari waktu ke waktu.
          </p>
        </div>
      </section>

      {/* Identitas usaha */}
      <section className="max-w-3xl mx-auto px-6 py-14">
        <h2 className="text-lg font-semibold mb-6">Identitas usaha</h2>
        <dl className="text-sm leading-relaxed space-y-3">
          <div>
            <dt className="font-semibold">Nama badan usaha</dt>
            <dd className="text-gray-600">Pian Yi Catering</dd>
          </div>
          <div>
            <dt className="font-semibold">
              Nomor Induk Berusaha (NIB)
            </dt>
            <dd className="text-gray-600">2307250135661</dd>
          </div>
          <div>
            <dt className="font-semibold">Alamat</dt>
            <dd className="text-gray-600">
              Jl. Palm Kuning IV Blok BE/06 Sekt.1-3, RT 002/RW 007, Kel.
              Rawabuntu, Kec. Serpong, Kota Tangerang Selatan, Provinsi Banten
              15318
            </dd>
          </div>
          <div>
            <dt className="font-semibold">WhatsApp</dt>
            <dd className="text-gray-600">
              <a href={WA_LINK} className="underline">
                {WA_DISPLAY}
              </a>
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Email</dt>
            <dd className="text-gray-600">
              <a href="mailto:drpramadyo@gmail.com" className="underline">
                drpramadyo@gmail.com
              </a>
            </dd>
          </div>
        </dl>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-gray-50">
        <div className="max-w-3xl mx-auto px-6 py-10 text-sm text-gray-600">
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <a href="/privacy" className="underline">
              Kebijakan Privasi
            </a>
            <a href="/terms" className="underline">
              Syarat &amp; Ketentuan
            </a>
            <a href="/data-deletion" className="underline">
              Penghapusan Data
            </a>
            {instagram && (
              <a
                href={`https://instagram.com/${instagram.replace(/^@/, "")}`}
                className="underline"
              >
                Instagram
              </a>
            )}
          </div>
          <p className="mt-6 text-xs text-gray-500">
            © {new Date().getFullYear()} Pian Yi Catering. Tangerang Selatan,
            Banten, Indonesia.
          </p>
        </div>
      </footer>
    </main>
  );
}
