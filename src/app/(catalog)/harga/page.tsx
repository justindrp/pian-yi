import type { Metadata } from "next";
import Link from "next/link";
import {
  chatLink,
  compareRows,
  loadCatalog,
  porsiRange,
  rupiah,
} from "@/lib/catalog/kitchens";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = {
  title: "Harga per porsi — Katerloka",
  description:
    "Harga per porsi tiap dapur partner, dari paket 5 porsi sampai paket besar. Makin banyak, makin murah.",
};

export const dynamic = "force-dynamic";

export default async function HargaPage() {
  const kitchens = await loadCatalog(createAdminClient());
  const rows = compareRows(kitchens);

  return (
    <>
      <header className="pl-hero pl-hero--short">
        <div className="pl-shell">
          <h1 className="pl-claim pl-claim--short">
            Makin banyak,
            <em>makin murah.</em>
          </h1>
          <p className="pl-lede">
            Harga per porsi tiap dapur, berdasarkan jumlah porsi dalam satu
            paket. Totalnya kami hitung dan kirim lewat chat.
          </p>
        </div>
      </header>

      <main className="pl-section">
        <div className="pl-shell">
          <div className="pl-compare-wrap">
            <table className="pl-compare">
              <thead>
                <tr>
                  <th scope="col">Porsi</th>
                  {kitchens.map((k) => (
                    <th key={k.slug} scope="col">
                      <Link href={`/menu/${k.slug}`}>{k.nickname}</Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.min}>
                    <th scope="row" className="pl-num">
                      {porsiRange(row.min, row.max)}
                    </th>
                    {row.prices.map((price, i) => (
                      <td key={kitchens[i].slug} className="pl-num">
                        {price === null ? "—" : rupiah(price)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Size M</th>
                  {kitchens.map((k) => (
                    <td key={k.slug} className="pl-num">
                      {k.sizeM === null ? "—" : `+${rupiah(k.sizeM)}`}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Tanpa nasi</th>
                  {kitchens.map((k) => (
                    <td key={k.slug} className="pl-num">
                      {k.noRiceOff > 0 ? `−${rupiah(k.noRiceOff)}` : "—"}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Hari antar</th>
                  {kitchens.map((k) => (
                    <td key={k.slug}>{k.daysLabel}</td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="pl-note">
            Rupiah per porsi. Jumlah porsi di antara dua baris ikut harga baris
            di atasnya. Ongkir, bila ada untuk lokasi kakak, dikonfirmasi lewat{" "}
            <a href={chatLink("Halo, saya mau tanya harga paket katering")}>
              chat
            </a>
            .
          </p>
        </div>
      </main>
    </>
  );
}
