import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { stripCompensation } from "@/lib/kitchen/compensation";
import { safeManualNote, splitPreferences } from "@/lib/kitchen/preferences";
import {
  kitchenCostPerPortion,
  normalizeSize,
  type OrderSize,
} from "@/lib/orders/size";
import {
  coverageFor,
  kitchenCoverage,
} from "@/lib/subcontractors/coverage";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatIDR } from "@/lib/utils/format";
import { displayPhone } from "@/lib/utils/phone";
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

// The kitchen prints `customers.kitchen_notes` and nothing else. That column is
// written by an admin or by extract_order's `catatan` — never by the
// summarizer, whose [AI learned context] block used to feed this page through a
// `Preferensi:` bullet. It cooked Carolin six portions without rice on
// 2026-09-01 off a restriction she had never given and had cancelled the day
// before, and the same block carries prices and coverage this page must never
// show: it is unauthenticated and shared with the subcontractor.
function kitchenPreferences(kitchenNotes: string | null): string | null {
  if (!kitchenNotes) return null;
  // Still filtered, not because a human is untrusted but because the page is
  // public: `safeManualNote` strips phone numbers and internal arrangements,
  // and `stripCompensation` strips the "(protein +25%)" we add ourselves.
  return safeManualNote(stripCompensation(kitchenNotes));
}

type Customer = {
  name: string | null;
  delivery_phone: string | null;
  kitchen_notes: string | null;
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
  const preference = splitPreferences(
    kitchenPreferences(c?.kitchen_notes ?? null),
  );
  // Buildings that refuse a lobby drop — Synergy among them — make the courier
  // someone who has to reach the customer, not only the address. Only the
  // customers who need it carry a number, because the page is unauthenticated:
  // this is `customers.delivery_phone`, set per customer from the Customers
  // screen, and blank for everyone else. It is deliberately not
  // `phone_number` — that would print the whole book on a shared link, and it
  // has no way to say "call Naya" for a customer like Cila, who is reachable
  // only through the person who buys for her. Never a number found in a note:
  // that is how Cila's card once printed Naya's WhatsApp under "Makanan:", and
  // `safeManualNote` still redacts those.
  const phone = displayPhone(c?.delivery_phone);

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
      {phone && (
        <div className="text-sm text-gray-700">
          Telp:{" "}
          <a href={`tel:${phone}`} className="text-blue-600 underline">
            {phone}
          </a>
        </div>
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

type RateLine = { size: OrderSize; rate: number; portions: number };
// Ongkir is charged per drop, not per portion, so it cannot fold into a rate
// line: a customer taking 3 porsi to one door pays one fee, and the same
// customer taking lunch and dinner pays two. Counted in deliveries.
type FeeLine = { rate: number; drops: number };
type Bill = {
  lines: RateLine[];
  fees: FeeLine[];
  portions: number;
  amount: number;
};

// What the kitchen is owed is one number for the whole day, so the bill is built
// from every delivery of the date — both sizes, both routes — and never from the
// size tab, which only exists to split the cook's dish list. Billing the tab paid
// a kitchen for its S portions and left the M ones off the page.
//
// Portions land on more than one rate for three reasons: size (M costs the S rate
// plus the surcharge), route, and an order's addon (Cindy's nasi merah, Rp
// 5.000/porsi). So group by (size, effective rate) — lines that agree on both
// merge, which is what happens now that a kitchen delivers every route itself.
function billFor(
  deliveries: Delivery[],
  rateOf: (d: Delivery) => number,
  feeOf: (d: Delivery) => number,
): Bill {
  const byKey = new Map<string, RateLine>();
  const byFee = new Map<number, FeeLine>();
  for (const d of deliveries) {
    const size = normalizeSize(d.orders?.size);
    const rate = rateOf(d);
    const key = `${size}-${rate}`;
    const line = byKey.get(key) ?? { size, rate, portions: 0 };
    line.portions += d.portions ?? 0;
    byKey.set(key, line);

    const fee = feeOf(d);
    if (fee > 0) {
      const feeLine = byFee.get(fee) ?? { rate: fee, drops: 0 };
      feeLine.drops += 1;
      byFee.set(fee, feeLine);
    }
  }
  const lines = [...byKey.values()].sort(
    (a, b) => a.size.localeCompare(b.size) || a.rate - b.rate,
  );
  const fees = [...byFee.values()].sort((a, b) => a.rate - b.rate);
  return {
    lines,
    fees,
    portions: lines.reduce((s, l) => s + l.portions, 0),
    amount:
      lines.reduce((s, l) => s + l.rate * l.portions, 0) +
      fees.reduce((s, f) => s + f.rate * f.drops, 0),
  };
}

function RateRow({
  line,
  showSize,
}: {
  line: RateLine;
  showSize: boolean;
}) {
  return (
    <div className="flex justify-between items-baseline gap-3">
      <span className="min-w-0">
        {showSize ? `Ukuran ${line.size.toUpperCase()}` : "Porsi"}{" "}
        <span className="text-gray-400 whitespace-nowrap">
          {line.portions} × {line.rate.toLocaleString("id-ID")}
        </span>
      </span>
      <span className="font-medium text-gray-800 whitespace-nowrap">
        {formatIDR(line.rate * line.portions)}
      </span>
    </div>
  );
}

// Named "Ongkir" rather than folded into the porsi line so the kitchen can see
// what it is being paid for the extra distance separately from the food.
function FeeRow({ fee }: { fee: FeeLine }) {
  return (
    <div className="flex justify-between items-baseline gap-3">
      <span className="min-w-0">
        Ongkir{" "}
        <span className="text-gray-400 whitespace-nowrap">
          {fee.drops} × {fee.rate.toLocaleString("id-ID")}
        </span>
      </span>
      <span className="font-medium text-gray-800 whitespace-nowrap">
        {formatIDR(fee.rate * fee.drops)}
      </span>
    </div>
  );
}

function MealSummary({
  title,
  bill,
  fallbackRate,
  showSize,
}: {
  title: string;
  bill: Bill;
  fallbackRate: number;
  showSize: boolean;
}) {
  const lines =
    bill.lines.length > 0
      ? bill.lines
      : [{ size: "s" as OrderSize, rate: fallbackRate, portions: 0 }];
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex justify-between items-baseline gap-3">
        <span className="font-medium text-gray-800">
          {title}{" "}
          <span className="text-sm text-gray-500">{bill.portions} porsi</span>
        </span>
        <span className="font-semibold text-gray-900 whitespace-nowrap">
          {formatIDR(bill.amount)}
        </span>
      </div>
      <div className="pl-3 space-y-1 text-sm text-gray-600 border-l-2 border-gray-100">
        {lines.map((l) => (
          <RateRow key={`${l.size}-${l.rate}`} line={l} showSize={showSize} />
        ))}
        {bill.fees.map((f) => (
          <FeeRow key={f.rate} fee={f} />
        ))}
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

  const [{ data: sub }, { data: rows }, coverage] = await Promise.all([
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
        "id, meal_type, portions, notes, address_slot, orders(addon_cost_per_portion, size), customers(name, delivery_phone, kitchen_notes, area, sub_area, address, google_maps_link, area_2, sub_area_2, address_2, google_maps_link_2, delivery_route)",
      )
      .eq("subcontractor_id", id)
      .eq("delivery_date", date),
    kitchenCoverage(db, id),
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

  // Each row is priced on its own order: M is a different dish list and costs the
  // S rate plus the surcharge, the route still picks a column, and the addon
  // rides on top. The summary below runs over allDeliveries, so the amount is
  // what the kitchen is owed for the day rather than for the open size tab.
  const rateOf = (d: Delivery) =>
    kitchenCostPerPortion(
      sub,
      normalizeSize(d.orders?.size),
      (d.customers?.delivery_route ?? 1) === 2 ? 2 : 1,
    ) + (d.orders?.addon_cost_per_portion ?? 0);
  // The ongkir this kitchen charges to reach a neighborhood it has priced —
  // Rp 10.000 to Apartemen Akasa, and nothing anywhere it has not ruled on. Read
  // off the address the courier is actually given, which is the second one when
  // the row carries slot 2, and matched the same way the bot matches it.
  const feeOf = (d: Delivery) => {
    const c = d.customers;
    const slot = d.address_slot ?? 1;
    return coverageFor(
      coverage,
      slot === 2 ? (c?.address_2 ?? c?.address) : c?.address,
      slot === 2 ? (c?.sub_area_2 ?? c?.sub_area) : c?.sub_area,
    ).surchargePerDelivery;
  };
  const mealBill = (meal: string) =>
    billFor(
      allDeliveries.filter((d) => d.meal_type === meal),
      rateOf,
      feeOf,
    );
  const bills = {
    breakfast: mealBill("breakfast"),
    lunch: mealBill("lunch"),
    dinner: mealBill("dinner"),
  };
  const fallbackRate = kitchenCostPerPortion(sub, "s", 2);
  const countsBySize: Record<OrderSize, number> = { s: 0, m: 0 };
  for (const d of allDeliveries) {
    countsBySize[normalizeSize(d.orders?.size)] += d.portions ?? 0;
  }
  const billTotal = Object.values(bills).reduce((s, b) => s + b.amount, 0);
  const billedPortions = Object.values(bills).reduce(
    (s, b) => s + b.portions,
    0,
  );

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
              <div className="text-sm text-gray-500">
                {billedPortions} porsi
              </div>
            </div>
          </div>

          {bills.breakfast.portions > 0 && (
            <MealSummary
              title="Makan Pagi"
              bill={bills.breakfast}
              fallbackRate={fallbackRate}
              showSize={offersM}
            />
          )}

          <MealSummary
            title="Makan Siang"
            bill={bills.lunch}
            fallbackRate={fallbackRate}
            showSize={offersM}
          />

          <MealSummary
            title="Makan Malam"
            bill={bills.dinner}
            fallbackRate={fallbackRate}
            showSize={offersM}
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
