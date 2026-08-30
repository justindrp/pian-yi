import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { stripCompensation } from "@/lib/kitchen/compensation";
import { splitPreferences } from "@/lib/kitchen/preferences";
import {
  kitchenCostPerPortion,
  normalizeSize,
  type OrderSize,
} from "@/lib/orders/size";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatIDR } from "@/lib/utils/format";
import { DatePicker } from "./date-picker";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pengiriman Pian Yi",
};

function getTomorrowWIB(): string {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  wib.setUTCDate(wib.getUTCDate() + 1);
  return wib.toISOString().slice(0, 10);
}

function formatDateID(dateStr: string): string {
  const days = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const months = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
  ];
  const d = new Date(`${dateStr}T00:00:00`);
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// customers.notes mixes two things: manual admin notes (dietary/drop-off
// instructions the kitchen needs) and an [AI learned context] block written by
// the chatbot, which also summarizes pricing and service coverage. This page is
// unauthenticated and shared with the subcontractor, so nothing from the AI
// block reaches it except what the two helpers below explicitly allow through.

const AI_BLOCK = /\[AI learned context\][\s\S]*?\[\/AI learned context\]/g;

function manualNotesOnly(notes: string): string | null {
  const stripped = notes.replace(AI_BLOCK, "");
  // An unterminated opening tag would otherwise survive the replace and print
  // the whole block; drop everything from it.
  const open = stripped.indexOf("[AI learned context]");
  return (open === -1 ? stripped : stripped.slice(0, open)).trim() || null;
}

// Some customers have no manual notes at all — everything the kitchen needs
// ("tidak ada seafood", "diambil di security") is inside the AI block. Pull the
// "Preferensi*" bullets back out of it, and only those: the sibling labels
// (Catatan, Pesanan, Area layanan, Harga…) carry cutoffs, bank details, and
// price points that the subcontractor has no reason to see.
const PREF_BULLET = /^[-•*]\s*\**\s*(Preferensi[^:*]{0,30})\**\s*:\s*(.+)$/i;
// Belt-and-braces: the model sometimes writes prices into a Preferensi bullet
// anyway ("Halal, harga terjangkau mulai 27RB, gratis ongkir"). Drop any line
// that mentions money — a dropped preference is recoverable, a leaked price
// list is not.
const MONEY = /\bRp\b|\d\s*(?:rb|ribu|k)\b|harga|ongkir|bayar|transfer|bca/i;
// A preference can also record that the customer is shopping around ("tertarik
// mencoba dapur berbeda untuk membandingkan menu dan kualitas"). True, but not
// something to hand the kitchen being compared. Matches comparison intent, not
// the word "dapur" on its own — "perlu konfirmasi ke dapur" is a normal note.
const COMPARISON =
  /bandingk|perbandingan|kompetitor|pesaing|beralih|pindah\s+ke|(?:dapur|catering|katering|vendor|penyedia)\s+(?:lain|berbeda|sebelah|baru)/i;
// The model also files our own ordering model under "Preferensi" ("sistem
// fleksibel, porsi bisa dipakai kapan saja"). That is how our packages work,
// not something the customer wants cooked differently — noise to the kitchen.
// Matched narrowly: "per porsi" and "paket" are excluded on purpose, because
// they show up in real food notes like "nasi + 3 lauk per porsi".
const ORDERING_MODEL =
  /pesan\s+bebas|jadwal\s+tetap|sistem\s+(?:pesan|fleksibel|pemesanan)|kuota|berturut-turut|porsi\s+bisa\s+dipakai|langganan/i;
// "Makan siang saja" tells the kitchen nothing: the card is already under the
// MAKAN SIANG heading. Anchored at both ends so only a clause that is nothing
// but a meal-time reference is dropped — "siang ayam-malam daging" stays.
const MEAL_ONLY =
  /^(?:hanya\s+|khusus\s+)?(?:untuk\s+)?(?:pengiriman\s+|makan(?:an)?\s+)?(?:siang|malam|lunch|dinner)(?:\s*\([^)]*\))?(?:\s+saja)?$/i;

// Filtering runs per clause, not per bullet: one line usually mixes something
// the kitchen needs with something it shouldn't see ("Makan siang saja, porsi
// kecil, sistem fleksibel …"), and dropping the whole line loses the useful
// half.
function usefulClauses(value: string): string[] {
  return (
    value
      .split(/[;,]/)
      .map((clause) => clause.trim())
      // "tanpa nasi (harga tetap sama)" is a single clause, and dropping it whole
      // for the price inside took the dietary request off the sheet with it.
      // Drop just the parenthetical, then judge what is left — the price never
      // prints either way, and a parenthetical that is not about money
      // ("(diganti ayam)") is untouched.
      .map((clause) =>
        clause.replace(/\s*\(([^)]*)\)/g, (whole, inner: string) =>
          MONEY.test(inner) ? "" : whole,
        ),
      )
      .filter(
        (clause) =>
          clause &&
          !MONEY.test(clause) &&
          !COMPARISON.test(clause) &&
          !ORDERING_MODEL.test(clause) &&
          !MEAL_ONLY.test(clause),
      )
  );
}

function aiPreferences(notes: string): string | null {
  const prefs: string[] = [];
  for (const block of notes.match(AI_BLOCK) ?? []) {
    for (const line of block.split("\n")) {
      const match = line.trim().match(PREF_BULLET);
      if (!match) continue;
      // Stripped before splitting: the compensation is a parenthetical hanging
      // off the request ("tanpa nasi (protein +25%)"), so a clause-level filter
      // would drop the request with it.
      const kept = usefulClauses(
        stripCompensation(match[2].replace(/\*\*/g, "")),
      );
      // Splitting can strand an opening paren whose closing half was in a
      // dropped clause; balance it rather than printing "porsi kecil (".
      const joined = kept.join(", ").replace(/\s*\($/, "");
      // Dropping a leading clause leaves the rest starting lowercase
      // ("porsi kecil"), so restore sentence case.
      const text = balanceParens(joined).replace(/^./, (c) => c.toUpperCase());
      if (text) prefs.push(text);
    }
  }
  return prefs.join("; ") || null;
}

function balanceParens(text: string): string {
  const opens = (text.match(/\(/g) ?? []).length;
  const closes = (text.match(/\)/g) ?? []).length;
  if (opens === closes) return text.trim();
  // Unbalanced either way means the sentence was cut mid-parenthetical; strip
  // the parens rather than leaving a dangling one.
  return text.replace(/[()]/g, "").trim();
}

function kitchenPreferences(notes: string | null): string | null {
  if (!notes) return null;
  // Manual notes get the same strip: an admin who typed the note in by hand
  // copied it from the same sentence the model reads.
  const manual = manualNotesOnly(notes);
  return (manual && stripCompensation(manual)) || aiPreferences(notes);
}

type Customer = {
  name: string | null;
  notes: string | null;
  area: string | null;
  sub_area: string | null;
  address: string | null;
  google_maps_link: string | null;
  area_2: string | null;
  sub_area_2: string | null;
  address_2: string | null;
  google_maps_link_2: string | null;
  delivery_route: number | null;
};

type Delivery = {
  id: string;
  meal_type: string;
  portions: number;
  notes: string | null;
  address_slot: number | null;
  customers: Customer | null;
  orders: { addon_cost_per_portion: number | null; size: string | null } | null;
};

function DeliveryCard({ d }: { d: Delivery }) {
  const c = d.customers;
  const slot = d.address_slot ?? 1;
  const area = slot === 2 ? (c?.area_2 ?? c?.area) : c?.area;
  const subArea = slot === 2 ? (c?.sub_area_2 ?? c?.sub_area) : c?.sub_area;
  const address = slot === 2 ? (c?.address_2 ?? c?.address) : c?.address;
  const mapsLink =
    slot === 2
      ? (c?.google_maps_link_2 ?? c?.google_maps_link)
      : c?.google_maps_link;
  const location = [area, subArea].filter(Boolean).join(" · ");
  const preference = splitPreferences(kitchenPreferences(c?.notes ?? null));

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-1">
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold text-gray-900 text-base">
          {c?.name ?? "—"}
        </span>
        <span className="text-sm font-semibold bg-orange-100 text-orange-700 px-2 py-0.5 rounded shrink-0">
          {d.portions} porsi
        </span>
      </div>
      {location && <div className="text-sm text-gray-500">{location}</div>}
      {address && <div className="text-sm text-gray-700">{address}</div>}
      {mapsLink && (
        <a
          href={mapsLink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-sm text-blue-600 underline"
        >
          Lihat di Maps
        </a>
      )}
      {preference.food && (
        <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded mt-1">
          Makanan: {preference.food}
        </div>
      )}
      {preference.delivery && (
        <div className="text-sm text-sky-800 bg-sky-50 border border-sky-200 px-3 py-1.5 rounded mt-1">
          Pengiriman: {preference.delivery}
        </div>
      )}
      {d.notes && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded mt-1">
          Catatan: {d.notes}
        </div>
      )}
    </div>
  );
}

type RateLine = { rate: number; portions: number };
type RouteBill = { lines: RateLine[]; portions: number; amount: number };

// An order can carry an addon the kitchen charges us on top of its route rate
// (Cindy's nasi merah, Rp 5.000/porsi), so one route can hold portions at more
// than one rate. Group by the effective rate rather than assuming a single one —
// the same grouping the COGS journal does.
function billFor(deliveries: Delivery[], baseRate: number): RouteBill {
  const byRate = new Map<number, number>();
  for (const d of deliveries) {
    const rate = baseRate + (d.orders?.addon_cost_per_portion ?? 0);
    byRate.set(rate, (byRate.get(rate) ?? 0) + (d.portions ?? 0));
  }
  const lines = [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rate, portions]) => ({ rate, portions }));
  return {
    lines,
    portions: lines.reduce((s, l) => s + l.portions, 0),
    amount: lines.reduce((s, l) => s + l.rate * l.portions, 0),
  };
}

function RouteRow({
  label,
  bill,
  baseRate,
}: {
  label: string;
  bill: RouteBill;
  baseRate: number;
}) {
  const lines =
    bill.lines.length > 0 ? bill.lines : [{ rate: baseRate, portions: 0 }];
  return (
    <div className="flex justify-between items-baseline gap-3">
      <span className="min-w-0">
        {label}{" "}
        <span className="text-gray-400">
          {lines.map((l, i) => (
            <span key={l.rate} className="whitespace-nowrap">
              {i > 0 ? " + " : ""}
              {l.portions} × {l.rate.toLocaleString("id-ID")}
            </span>
          ))}
        </span>
      </span>
      <span className="font-medium text-gray-800 whitespace-nowrap">
        {formatIDR(bill.amount)}
      </span>
    </div>
  );
}

function MealSummary({
  title,
  subName,
  route1,
  route2,
  rate1,
  rate2,
}: {
  title: string;
  subName: string;
  route1: RouteBill;
  route2: RouteBill;
  rate1: number;
  rate2: number;
}) {
  const portions = route1.portions + route2.portions;
  const amount = route1.amount + route2.amount;
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex justify-between items-baseline gap-3">
        <span className="font-medium text-gray-800">
          {title}{" "}
          <span className="text-sm text-gray-500">{portions} porsi</span>
        </span>
        <span className="font-semibold text-gray-900 whitespace-nowrap">
          {formatIDR(amount)}
        </span>
      </div>
      <div className="pl-3 space-y-1 text-sm text-gray-600 border-l-2 border-gray-100">
        <RouteRow label="Rute 1 (Pian Yi)" bill={route1} baseRate={rate1} />
        <RouteRow
          label={`Rute 2 (${subName})`}
          bill={route2}
          baseRate={rate2}
        />
      </div>
    </div>
  );
}

// Only the kitchens that cook M see these. S and M are different dish lists —
// M adds the second side — so the cook needs the day split, not one merged
// sheet with a badge per card.
function SizeTabs({
  id,
  date,
  active,
  counts,
}: {
  id: string;
  date: string;
  active: OrderSize;
  counts: Record<OrderSize, number>;
}) {
  const tabs: { size: OrderSize; label: string }[] = [
    { size: "s", label: "Ukuran S" },
    { size: "m", label: "Ukuran M" },
  ];
  return (
    <div className="flex gap-2">
      {tabs.map((t) => (
        <Link
          key={t.size}
          href={`/dapur/${id}?date=${date}&size=${t.size}`}
          className={`flex-1 text-center rounded-lg border px-3 py-2 text-sm font-semibold ${
            t.size === active
              ? "bg-orange-500 border-orange-500 text-white"
              : "bg-white border-gray-200 text-gray-600"
          }`}
        >
          {t.label}{" "}
          <span
            className={t.size === active ? "text-orange-100" : "text-gray-400"}
          >
            {counts[t.size]} porsi
          </span>
        </Link>
      ))}
    </div>
  );
}

function Section({
  title,
  deliveries,
}: {
  title: string;
  deliveries: Delivery[];
}) {
  if (deliveries.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 px-1">
        {title}
      </h2>
      {deliveries.map((d) => (
        <DeliveryCard key={d.id} d={d} />
      ))}
    </div>
  );
}

export default async function DapurPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string; size?: string }>;
}) {
  const { id } = await params;
  const { date: dateParam, size: sizeParam } = await searchParams;
  const date = dateParam ?? getTomorrowWIB();

  const db = createAdminClient();

  const [{ data: sub }, { data: rows }] = await Promise.all([
    db
      .from("subcontractors")
      .select(
        "id, name, cost_per_portion, cost_per_portion_route1, offers_size_m, cost_per_portion_m, cost_per_portion_route1_m",
      )
      .eq("id", id)
      .single(),
    db
      .from("daily_deliveries")
      .select(
        "id, meal_type, portions, notes, address_slot, orders(addon_cost_per_portion, size), customers(name, notes, area, sub_area, address, google_maps_link, area_2, sub_area_2, address_2, google_maps_link_2, delivery_route)",
      )
      .eq("subcontractor_id", id)
      .eq("delivery_date", date),
  ]);

  if (!sub) notFound();

  // A delivery has no size of its own — it has an order, and the order has the
  // size. Kept that way on purpose: a size copied onto the row would go stale
  // the moment the order's did.
  const allDeliveries = (rows ?? []) as Delivery[];
  const offersM = sub.offers_size_m === true;
  const activeSize: OrderSize = offersM ? normalizeSize(sizeParam) : "s";
  const deliveries = offersM
    ? allDeliveries.filter((d) => normalizeSize(d.orders?.size) === activeSize)
    : allDeliveries;

  // "breakfast" only appears on event bookings — the standing packages have no
  // morning slot, so most kitchens will never have one. The summary line and the
  // two sections below are therefore rendered only when the day actually has
  // morning rows, rather than adding an empty "Makan Pagi — 0 porsi" to every
  // kitchen's page. Before this the rows were fetched and then silently dropped
  // by the lunch/dinner filters: ICE BSD's three morning runs were invisible to
  // the kitchen cooking them, and its bill read Rp 0 against Rp 900.000 owed.
  const breakfastR1 = deliveries.filter(
    (d) =>
      d.meal_type === "breakfast" && (d.customers?.delivery_route ?? 1) === 1,
  );
  const breakfastR2 = deliveries.filter(
    (d) =>
      d.meal_type === "breakfast" && (d.customers?.delivery_route ?? 1) === 2,
  );
  const lunchR1 = deliveries.filter(
    (d) => d.meal_type === "lunch" && (d.customers?.delivery_route ?? 1) === 1,
  );
  const lunchR2 = deliveries.filter(
    (d) => d.meal_type === "lunch" && (d.customers?.delivery_route ?? 1) === 2,
  );
  const dinnerR1 = deliveries.filter(
    (d) => d.meal_type === "dinner" && (d.customers?.delivery_route ?? 1) === 1,
  );
  const dinnerR2 = deliveries.filter(
    (d) => d.meal_type === "dinner" && (d.customers?.delivery_route ?? 1) === 2,
  );

  // M is a different dish list, so the kitchen bills it at its own pair of
  // route rates; a kitchen that does not cook M has neither and stays on S.
  const rate1 = kitchenCostPerPortion(sub, activeSize, 1);
  const rate2 = kitchenCostPerPortion(sub, activeSize, 2);
  const bills = {
    breakfastR1: billFor(breakfastR1, rate1),
    breakfastR2: billFor(breakfastR2, rate2),
    lunchR1: billFor(lunchR1, rate1),
    lunchR2: billFor(lunchR2, rate2),
    dinnerR1: billFor(dinnerR1, rate1),
    dinnerR2: billFor(dinnerR2, rate2),
  };
  const total = deliveries.reduce((s, d) => s + (d.portions ?? 0), 0);
  const countsBySize: Record<OrderSize, number> = { s: 0, m: 0 };
  for (const d of allDeliveries) {
    countsBySize[normalizeSize(d.orders?.size)] += d.portions ?? 0;
  }
  const billTotal = Object.values(bills).reduce((s, b) => s + b.amount, 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              Pian Yi Catering
            </h1>
            <p className="text-gray-500 text-sm mt-0.5">{formatDateID(date)}</p>
          </div>
          <DatePicker id={id} date={date} size={offersM ? activeSize : null} />
        </div>

        {offersM && (
          <SizeTabs
            id={id}
            date={date}
            active={activeSize}
            counts={countsBySize}
          />
        )}

        {/* Summary */}
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          <div className="flex justify-between items-center gap-3 px-4 py-3">
            <span className="font-bold text-gray-900">Total</span>
            <div className="text-right">
              <div className="text-lg font-bold text-gray-900">
                {formatIDR(billTotal)}
              </div>
              <div className="text-sm text-gray-500">{total} porsi</div>
            </div>
          </div>

          {breakfastR1.length + breakfastR2.length > 0 && (
            <MealSummary
              title="Makan Pagi"
              subName={sub.name}
              route1={bills.breakfastR1}
              route2={bills.breakfastR2}
              rate1={rate1}
              rate2={rate2}
            />
          )}

          <MealSummary
            title="Makan Siang"
            subName={sub.name}
            route1={bills.lunchR1}
            route2={bills.lunchR2}
            rate1={rate1}
            rate2={rate2}
          />

          <MealSummary
            title="Makan Malam"
            subName={sub.name}
            route1={bills.dinnerR1}
            route2={bills.dinnerR2}
            rate1={rate1}
            rate2={rate2}
          />
        </div>

        {/* Order lists */}
        {deliveries.length === 0 ? (
          <p className="text-center text-gray-400 py-12 text-sm">
            {offersM
              ? `Belum ada pengiriman ukuran ${activeSize.toUpperCase()} untuk tanggal ini`
              : "Belum ada pengiriman terjadwal untuk tanggal ini"}
          </p>
        ) : (
          <div className="space-y-8">
            <Section
              title="Makan Pagi — Rute 1 (Pian Yi)"
              deliveries={breakfastR1}
            />
            <Section
              title={`Makan Pagi — Rute 2 (${sub.name})`}
              deliveries={breakfastR2}
            />
            <Section
              title="Makan Siang — Rute 1 (Pian Yi)"
              deliveries={lunchR1}
            />
            <Section
              title={`Makan Siang — Rute 2 (${sub.name})`}
              deliveries={lunchR2}
            />
            <Section
              title="Makan Malam — Rute 1 (Pian Yi)"
              deliveries={dinnerR1}
            />
            <Section
              title={`Makan Malam — Rute 2 (${sub.name})`}
              deliveries={dinnerR2}
            />
          </div>
        )}
      </div>
    </div>
  );
}
