import Link from "next/link";
import {
  ADDRESS,
  BRAND,
  type CatalogKitchen,
  CONTACT_EMAIL,
  chatLink,
  LEGAL_NAME,
  NIB,
  slugify,
  WA_DISPLAY,
} from "@/lib/catalog/kitchens";

// Placeholder backgrounds until each kitchen has its own photography. Dealt
// out by the kitchen's place among all slugs, so each kitchen keeps its colour
// between pages and no two share one while there are six or fewer.
const TINTS = [
  "#F2D7AE",
  "#CFE0C3",
  "#F3CBBE",
  "#C9D8E2",
  "#E6D3EC",
  "#F5E3A8",
];

export function tint(slug: string, all: CatalogKitchen[]): string {
  const i = all
    .map((k) => k.slug)
    .sort()
    .indexOf(slug);
  return TINTS[Math.max(i, 0) % TINTS.length];
}

const rb = (n: number) => (n / 1000).toLocaleString("id-ID");

/** "Rp 25–29rb": cheapest to dearest per-portion price. */
export function priceRange(k: CatalogKitchen): string {
  const dearest = Math.max(...k.tiers.map((t) => t.price_per_portion));
  return k.from === dearest
    ? `Rp ${rb(k.from)}rb`
    : `Rp ${rb(k.from)}–${rb(dearest)}rb`;
}

export function kitchenTags(k: CatalogKitchen): string[] {
  const tags: string[] = [];
  if (k.sizeM !== null) tags.push("Size M");
  if (k.days.length === 7) tags.push("7 hari");
  if (k.noRiceOff > 0) tags.push("Tanpa nasi");
  return tags;
}

/** The empty-plate mark standing in for a photo. */
export function PlateIcon({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgba(26,26,26,0.35)"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
    </svg>
  );
}

export function PinIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--kl-accent)"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function KitchenRow({
  kitchen,
  area,
  color,
}: {
  kitchen: CatalogKitchen;
  area: string | null;
  color: string;
}) {
  const href = area
    ? `/menu/${kitchen.slug}?area=${slugify(area)}`
    : `/menu/${kitchen.slug}`;
  return (
    <li>
      <Link href={href} className="kl-row">
        <span className="kl-thumb kl-thumb--row" style={{ background: color }}>
          <PlateIcon />
        </span>
        <span className="kl-row-body">
          <span className="kl-row-name">{kitchen.nickname}</span>
          {kitchen.blurb && (
            <span className="kl-row-blurb">{kitchen.blurb}</span>
          )}
          <span className="kl-row-sub">
            Antar ke {kitchen.areas.join(", ")}
          </span>
          <span className="kl-row-days">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
              <path d="M3.5 10h17M8 3v4M16 3v4" />
            </svg>
            {kitchen.daysLabel}
          </span>
          <span className="kl-row-price">
            <span className="kl-price">{priceRange(kitchen)}</span>
            <span className="kl-per">/porsi</span>
            {kitchenTags(kitchen).map((t) => (
              <span key={t} className="kl-tag">
                {t}
              </span>
            ))}
          </span>
        </span>
      </Link>
    </li>
  );
}

// The filters a customer can apply, each a fact carried on the kitchen's row.
const FILTERS: {
  id: string;
  label: string;
  test: (k: CatalogKitchen) => boolean;
}[] = [
  { id: "m", label: "Ada size M", test: (k) => k.sizeM !== null },
  { id: "7", label: "Kirim tiap hari", test: (k) => k.days.length === 7 },
  { id: "nasi", label: "Bisa tanpa nasi", test: (k) => k.noRiceOff > 0 },
];

/**
 * The home screen: pick an area, narrow by a filter, see the kitchens. Area and
 * filter live in the URL (`/area/[slug]?f=m`), so a filtered list survives
 * being forwarded and needs no client state.
 */
export function CatalogHome({
  kitchens,
  areas,
  area,
  filter,
  deadline,
  minPortions,
}: {
  kitchens: CatalogKitchen[];
  areas: string[];
  area: string | null;
  filter: string | null;
  deadline: string;
  minPortions: number;
}) {
  const here = area ? kitchens.filter((k) => k.areas.includes(area)) : kitchens;
  // A filter no kitchen here satisfies is not offered: it could only ever
  // produce an empty list.
  const filters = FILTERS.filter((f) => here.some(f.test));
  const active = filters.find((f) => f.id === filter) ?? null;
  const list = active ? here.filter(active.test) : here;
  const base = area ? `/area/${slugify(area)}` : "/";

  return (
    <>
      <div className="kl-top">
        <details className="kl-area">
          <summary>
            <span className="kl-area-hint">Antar ke</span>
            <span className="kl-area-name">
              <PinIcon />
              {area ?? "Semua area"}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </summary>
          <ul className="kl-area-list">
            <li>
              <Link href="/" aria-current={area === null}>
                Semua area
              </Link>
            </li>
            {areas.map((a) => (
              <li key={a}>
                <Link href={`/area/${slugify(a)}`} aria-current={a === area}>
                  {a}
                </Link>
              </li>
            ))}
          </ul>
        </details>
        <span className="kl-brand">{BRAND}</span>
      </div>

      {filters.length > 0 && (
        <nav className="kl-scroll kl-chips" aria-label="Saring dapur">
          <Link href={base} className="kl-chip" aria-current={active === null}>
            Semua
          </Link>
          {filters.map((f) => (
            <Link
              key={f.id}
              href={`${base}?f=${f.id}`}
              className="kl-chip"
              aria-current={active?.id === f.id}
            >
              {f.label}
            </Link>
          ))}
        </nav>
      )}

      <div className="kl-banner">
        <strong>
          Pesan sebelum {deadline},
          <br />
          diantar besok
        </strong>
        <p>
          Mulai {minPortions} porsi. Makin banyak porsinya, makin murah per
          porsi.
        </p>
        <span className="kl-banner-mark" aria-hidden="true">
          {deadline}
        </span>
      </div>

      <h2 className="kl-h2">
        {area
          ? `${list.length} dapur antar ke ${area}`
          : `${list.length} dapur partner`}
      </h2>
      {list.length > 0 ? (
        <ul className="kl-rows">
          {list.map((k) => (
            <KitchenRow
              key={k.slug}
              kitchen={k}
              area={area}
              color={tint(k.slug, kitchens)}
            />
          ))}
        </ul>
      ) : (
        <p className="kl-empty">
          Belum ada dapur untuk pilihan ini.{" "}
          <Link href={base}>Hapus saringan</Link>, atau{" "}
          <a
            href={chatLink(
              "Halo, saya mau tanya dapur yang antar ke area saya",
            )}
          >
            tanya kami lewat chat
          </a>
          .
        </p>
      )}

      <p className="kl-legal">
        Dimasak oleh dapur partner kami, dipesan dan diantar oleh {BRAND}. Area
        kakak belum ada?{" "}
        <a
          href={chatLink(
            "Halo, area saya belum ada di daftar. Bisa antar ke sini?",
          )}
        >
          Tanya kami
        </a>
        .
        <br />
        {LEGAL_NAME} · NIB {NIB} · KBLI 56290
        <br />
        {ADDRESS.street}, {ADDRESS.city}, {ADDRESS.region} {ADDRESS.postalCode}
        <br />
        <a href={chatLink()}>{WA_DISPLAY}</a> ·{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        <br />
        <a href="/terms">Syarat &amp; ketentuan</a> ·{" "}
        <a href="/privacy">Kebijakan privasi</a> ·{" "}
        <a href="/data-deletion">Penghapusan data</a>
      </p>
    </>
  );
}
