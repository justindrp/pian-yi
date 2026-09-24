import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  BRAND,
  type CatalogKitchen,
  catalogAreas,
  chatLink,
  loadCatalog,
  orderDeadlineLabel,
  rupiah,
  slugify,
} from "@/lib/catalog/kitchens";
import { createAdminClient } from "@/lib/supabase/admin";
import { BackIcon, CheckIcon, PlateIcon, priceRange, tint } from "../../ui";

export const dynamic = "force-dynamic";

async function findKitchen(
  slug: string,
): Promise<{ kitchen: CatalogKitchen; all: CatalogKitchen[] } | null> {
  const all = await loadCatalog(createAdminClient());
  const kitchen = all.find((k) => k.slug === slug);
  return kitchen ? { kitchen, all } : null;
}

export async function generateMetadata(props: {
  params: Promise<{ dapur: string }>;
}): Promise<Metadata> {
  const kitchen = (await findKitchen((await props.params).dapur))?.kitchen;
  if (!kitchen) return {};
  return {
    title: `${kitchen.nickname} — Katerloka`,
    description: `Katering harian ${kitchen.nickname}: mulai Rp ${rupiah(kitchen.from)} per porsi, antar ${kitchen.daysLabel} ke ${kitchen.areas.join(", ")}.`,
  };
}

const WEEKDAY_ID = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];
const TABS = [
  { id: "paket", label: "Paket" },
  { id: "menu", label: "Menu" },
  { id: "info", label: "Info" },
];

type Pkg = { portions: number; per: number; total: number; save: number };

function PackageRow({
  pkg,
  kitchen,
  color,
}: {
  pkg: Pkg;
  kitchen: CatalogKitchen;
  color: string;
}) {
  return (
    <div className="kl-pkg">
      <div className="kl-pkg-body">
        <span className="kl-pkg-name">{pkg.portions} porsi</span>
        <span className="kl-per">Rp {rupiah(pkg.per)} /porsi</span>
        {pkg.save > 0 && (
          <span
            className="kl-tag kl-tag--ok"
            style={{ alignSelf: "flex-start" }}
          >
            Hemat Rp {rupiah(pkg.save)}
          </span>
        )}
        <span className="kl-pkg-total">Rp {rupiah(pkg.total)}</span>
      </div>
      <div className="kl-pkg-side">
        <span className="kl-thumb kl-thumb--pkg" style={{ background: color }}>
          {pkg.portions}×
        </span>
        <a
          className="kl-add"
          href={chatLink(
            `Halo, saya mau pesan paket ${pkg.portions} porsi dari ${kitchen.nickname}`,
          )}
        >
          Pesan
        </a>
      </div>
    </div>
  );
}

export default async function KitchenPage(props: {
  params: Promise<{ dapur: string }>;
  searchParams: Promise<{ tab?: string; area?: string }>;
}) {
  const [found, deadline, query] = await Promise.all([
    props.params.then((p) => findKitchen(p.dapur)),
    orderDeadlineLabel(),
    props.searchParams,
  ]);
  if (!found) notFound();
  const { kitchen, all } = found;

  const tab = TABS.some((t) => t.id === query.tab) ? query.tab : "paket";
  // The area the customer came from, if any. Resolved against every area the
  // catalog serves, so an unknown slug is ignored rather than echoed back.
  const area = catalogAreas(all).find((a) => slugify(a) === query.area) ?? null;
  const serves = area ? kitchen.areas.includes(area) : true;
  const areaQuery = area ? `&area=${slugify(area)}` : "";
  const color = tint(kitchen.slug, all);
  const back = area ? `/area/${slugify(area)}` : "/menu";

  // Every size on the ladder is a package. The first size of each price step is
  // shown; the rest sit behind "Ukuran lain" as in the design.
  const smallest = [...kitchen.tiers].sort((a, b) => a.portions - b.portions);
  const base = smallest[0]?.price_per_portion ?? 0;
  const pkgs: Pkg[] = smallest.map((t) => ({
    portions: t.portions,
    per: t.price_per_portion,
    total: t.price_per_portion * t.portions,
    save: (base - t.price_per_portion) * t.portions,
  }));
  const main = new Set(kitchen.rungs.map((r) => r.min));
  const more = pkgs.filter((p) => !main.has(p.portions));

  return (
    <>
      <div className="kl-hero" style={{ background: color }}>
        <PlateIcon size={48} />
        <Link
          href={back}
          aria-label="Kembali"
          className="kl-round kl-round--left"
        >
          <BackIcon />
        </Link>
      </div>

      <div className="kl-card">
        <div>
          <h1>{kitchen.nickname}</h1>
          <p className="kl-card-sub">
            Dapur partner {BRAND}. Antar ke {kitchen.areas.length} area.
          </p>
        </div>
        <div className="kl-stats">
          <div>
            <strong>{kitchen.daysLabel}</strong>
            <span>hari kirim</span>
          </div>
          <div>
            <strong>{priceRange(kitchen)}</strong>
            <span>per porsi</span>
          </div>
          <div>
            <strong>{deadline}</strong>
            <span>tutup H-1</span>
          </div>
        </div>
        {area && (
          <div className={serves ? "kl-serves" : "kl-serves kl-serves--no"}>
            {serves && <CheckIcon />}
            {serves ? `Antar ke ${area}` : `Belum antar ke ${area}`}
          </div>
        )}
      </div>

      <nav className="kl-tabs" aria-label="Bagian">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/menu/${kitchen.slug}?tab=${t.id}${areaQuery}`}
            aria-current={t.id === tab ? "page" : undefined}
            scroll={false}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "paket" && (
        <>
          <p className="kl-lead">
            Satu paket = sejumlah porsi yang kakak jadwalkan sendiri, siang atau
            malam. Makin besar paketnya, makin murah per porsi.
            {kitchen.sizeM !== null &&
              ` Size M +Rp ${rupiah(kitchen.sizeM)}/porsi.`}
            {kitchen.noRiceOff > 0 &&
              ` Tanpa nasi −Rp ${rupiah(kitchen.noRiceOff)}/porsi.`}
          </p>
          {pkgs
            .filter((p) => main.has(p.portions))
            .map((p) => (
              <PackageRow
                key={p.portions}
                pkg={p}
                kitchen={kitchen}
                color={color}
              />
            ))}
          {more.length > 0 && (
            <details className="kl-more">
              <summary>
                Ukuran lain: {more.map((p) => p.portions).join(", ")} porsi
              </summary>
              {more.map((p) => (
                <PackageRow
                  key={p.portions}
                  pkg={p}
                  kitchen={kitchen}
                  color={color}
                />
              ))}
            </details>
          )}
        </>
      )}

      {tab === "menu" && (
        <div
          className="kl-empty"
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <span>
            <strong>Menu minggu ini belum diunggah di sini.</strong> Dapurnya
            tetap masak; tanya menunya lewat chat.
          </span>
          <a
            className="kl-dark-btn"
            href={chatLink(
              `Halo, boleh lihat menu ${kitchen.nickname} minggu ini?`,
            )}
          >
            Tanya menu
          </a>
        </div>
      )}

      {tab === "info" && (
        <div className="kl-info">
          <section>
            <span className="kl-label">Hari kirim</span>
            <div className="kl-week">
              {WEEKDAY_ID.map((label, i) => (
                <span
                  key={label}
                  data-off={kitchen.days.includes(i + 1) ? undefined : ""}
                >
                  {label}
                </span>
              ))}
            </div>
          </section>
          <section>
            <span className="kl-label">Area antar</span>
            <div className="kl-pills">
              {kitchen.areas.map((a) => (
                <span key={a} data-on={a === area ? "" : undefined}>
                  {a}
                </span>
              ))}
            </div>
            <p className="kl-per">
              Ongkir, bila ada untuk lokasi kakak, dikonfirmasi lewat chat.
            </p>
          </section>
          <section>
            <span className="kl-label">Pesan, ubah, libur</span>
            <p>
              Paling lambat {deadline} WIB sehari sebelum tanggal kirim. Hari
              yang diliburkan tidak memotong porsi.
            </p>
          </section>
          <section>
            <span className="kl-label">Siapa yang memasak</span>
            <p>
              Dapur partner kami. Pesanan, pembayaran dan pengantaran diurus
              oleh {BRAND}.
            </p>
          </section>
        </div>
      )}
    </>
  );
}
