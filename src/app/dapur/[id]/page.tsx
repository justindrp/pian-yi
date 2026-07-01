import { createAdminClient } from "@/lib/supabase/admin";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
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

type Customer = {
  name: string | null;
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
};

function DeliveryCard({ d }: { d: Delivery }) {
  const c = d.customers;
  const slot = d.address_slot ?? 1;
  const area = slot === 2 ? (c?.area_2 ?? c?.area) : c?.area;
  const subArea = slot === 2 ? (c?.sub_area_2 ?? c?.sub_area) : c?.sub_area;
  const address = slot === 2 ? (c?.address_2 ?? c?.address) : c?.address;
  const mapsLink = slot === 2 ? (c?.google_maps_link_2 ?? c?.google_maps_link) : c?.google_maps_link;
  const location = [area, subArea].filter(Boolean).join(" · ");

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-1">
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold text-gray-900 text-base">{c?.name ?? "—"}</span>
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
      {d.notes && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded mt-1">
          Catatan: {d.notes}
        </div>
      )}
    </div>
  );
}

function Section({ title, deliveries }: { title: string; deliveries: Delivery[] }) {
  if (deliveries.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400 px-1">{title}</h2>
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
  searchParams: Promise<{ date?: string }>;
}) {
  const { id } = await params;
  const { date: dateParam } = await searchParams;
  const date = dateParam ?? getTomorrowWIB();

  const db = createAdminClient();

  const [{ data: sub }, { data: rows }] = await Promise.all([
    db.from("subcontractors").select("id, name").eq("id", id).single(),
    db
      .from("daily_deliveries")
      .select(
        "id, meal_type, portions, notes, address_slot, customers(name, area, sub_area, address, google_maps_link, area_2, sub_area_2, address_2, google_maps_link_2, delivery_route)",
      )
      .eq("subcontractor_id", id)
      .eq("delivery_date", date)
      .in("status", ["scheduled", "delivered"]),
  ]);

  if (!sub) notFound();

  const deliveries = (rows ?? []) as Delivery[];

  let lunchRute1 = 0,
    lunchRute2 = 0,
    dinnerRute1 = 0,
    dinnerRute2 = 0;

  for (const d of deliveries) {
    const route = d.customers?.delivery_route ?? 1;
    const p = d.portions ?? 0;
    if (d.meal_type === "lunch") {
      if (route === 1) lunchRute1 += p;
      else lunchRute2 += p;
    } else if (d.meal_type === "dinner") {
      if (route === 1) dinnerRute1 += p;
      else dinnerRute2 += p;
    }
  }

  const lunch = lunchRute1 + lunchRute2;
  const dinner = dinnerRute1 + dinnerRute2;
  const total = lunch + dinner;

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

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Pian Yi Catering</h1>
            <p className="text-gray-500 text-sm mt-0.5">{formatDateID(date)}</p>
          </div>
          <DatePicker id={id} date={date} />
        </div>

        {/* Summary */}
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          <div className="flex justify-between items-center px-4 py-3">
            <span className="font-bold text-gray-900">Total</span>
            <span className="text-lg font-bold text-gray-900">{total} porsi</span>
          </div>

          <div className="px-4 py-3 space-y-2">
            <div className="flex justify-between items-center">
              <span className="font-medium text-gray-800">Makan Siang</span>
              <span className="font-semibold text-gray-900">{lunch} porsi</span>
            </div>
            <div className="pl-3 space-y-1 text-sm text-gray-600 border-l-2 border-gray-100">
              <div className="flex justify-between">
                <span>Rute 1 (diantar Pian Yi)</span>
                <span className="font-medium text-gray-800">{lunchRute1}</span>
              </div>
              <div className="flex justify-between">
                <span>Rute 2 (diantar {sub.name})</span>
                <span className="font-medium text-gray-800">{lunchRute2}</span>
              </div>
            </div>
          </div>

          <div className="px-4 py-3 space-y-2">
            <div className="flex justify-between items-center">
              <span className="font-medium text-gray-800">Makan Malam</span>
              <span className="font-semibold text-gray-900">{dinner} porsi</span>
            </div>
            <div className="pl-3 space-y-1 text-sm text-gray-600 border-l-2 border-gray-100">
              <div className="flex justify-between">
                <span>Rute 1 (diantar Pian Yi)</span>
                <span className="font-medium text-gray-800">{dinnerRute1}</span>
              </div>
              <div className="flex justify-between">
                <span>Rute 2 (diantar {sub.name})</span>
                <span className="font-medium text-gray-800">{dinnerRute2}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Order lists */}
        {deliveries.length === 0 ? (
          <p className="text-center text-gray-400 py-12 text-sm">
            Belum ada pengiriman terjadwal untuk tanggal ini
          </p>
        ) : (
          <div className="space-y-8">
            <Section title="Makan Siang — Rute 1 (Pian Yi)" deliveries={lunchR1} />
            <Section title={`Makan Siang — Rute 2 (${sub.name})`} deliveries={lunchR2} />
            <Section title="Makan Malam — Rute 1 (Pian Yi)" deliveries={dinnerR1} />
            <Section title={`Makan Malam — Rute 2 (${sub.name})`} deliveries={dinnerR2} />
          </div>
        )}
      </div>
    </div>
  );
}
