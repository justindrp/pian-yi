import type { Metadata } from "next";
import { notFound } from "next/navigation";
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
  return value
    .split(/[;,]/)
    .map((clause) => clause.trim())
    .filter(
      (clause) =>
        clause &&
        !MONEY.test(clause) &&
        !COMPARISON.test(clause) &&
        !ORDERING_MODEL.test(clause) &&
        !MEAL_ONLY.test(clause),
    );
}

function aiPreferences(notes: string): string | null {
  const prefs: string[] = [];
  for (const block of notes.match(AI_BLOCK) ?? []) {
    for (const line of block.split("\n")) {
      const match = line.trim().match(PREF_BULLET);
      if (!match) continue;
      const kept = usefulClauses(match[2].replace(/\*\*/g, ""));
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
  return manualNotesOnly(notes) ?? aiPreferences(notes);
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
  const preference = kitchenPreferences(c?.notes ?? null);

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
      {preference && (
        <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded mt-1">
          Preferensi: {preference}
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

type RouteBill = { portions: number; rate: number; amount: number };

function RouteRow({ label, bill }: { label: string; bill: RouteBill }) {
  return (
    <div className="flex justify-between items-baseline gap-3">
      <span className="min-w-0">
        {label}{" "}
        <span className="text-gray-400 whitespace-nowrap">
          {bill.portions} × {bill.rate.toLocaleString("id-ID")}
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
  portions,
  amount,
  subName,
  route1,
  route2,
}: {
  title: string;
  portions: number;
  amount: number;
  subName: string;
  route1: RouteBill;
  route2: RouteBill;
}) {
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
        <RouteRow label="Rute 1 (Pian Yi)" bill={route1} />
        <RouteRow label={`Rute 2 (${subName})`} bill={route2} />
      </div>
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
  searchParams: Promise<{ date?: string }>;
}) {
  const { id } = await params;
  const { date: dateParam } = await searchParams;
  const date = dateParam ?? getTomorrowWIB();

  const db = createAdminClient();

  const [{ data: sub }, { data: rows }] = await Promise.all([
    db
      .from("subcontractors")
      .select("id, name, cost_per_portion, cost_per_portion_route1")
      .eq("id", id)
      .single(),
    db
      .from("daily_deliveries")
      .select(
        "id, meal_type, portions, notes, address_slot, customers(name, notes, area, sub_area, address, google_maps_link, area_2, sub_area_2, address_2, google_maps_link_2, delivery_route)",
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

  // Route 1 is our own courier, so the kitchen charges less for it. A null
  // override means this kitchen bills one rate for both routes.
  const rate2 = sub.cost_per_portion ?? 0;
  const rate1 = sub.cost_per_portion_route1 ?? rate2;
  const billLunchR1 = lunchRute1 * rate1;
  const billLunchR2 = lunchRute2 * rate2;
  const billDinnerR1 = dinnerRute1 * rate1;
  const billDinnerR2 = dinnerRute2 * rate2;
  const billLunch = billLunchR1 + billLunchR2;
  const billDinner = billDinnerR1 + billDinnerR2;
  const billTotal = billLunch + billDinner;

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
            <h1 className="text-xl font-bold text-gray-900">
              Pian Yi Catering
            </h1>
            <p className="text-gray-500 text-sm mt-0.5">{formatDateID(date)}</p>
          </div>
          <DatePicker id={id} date={date} />
        </div>

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

          <MealSummary
            title="Makan Siang"
            portions={lunch}
            amount={billLunch}
            subName={sub.name}
            route1={{ portions: lunchRute1, rate: rate1, amount: billLunchR1 }}
            route2={{ portions: lunchRute2, rate: rate2, amount: billLunchR2 }}
          />

          <MealSummary
            title="Makan Malam"
            portions={dinner}
            amount={billDinner}
            subName={sub.name}
            route1={{
              portions: dinnerRute1,
              rate: rate1,
              amount: billDinnerR1,
            }}
            route2={{
              portions: dinnerRute2,
              rate: rate2,
              amount: billDinnerR2,
            }}
          />
        </div>

        {/* Order lists */}
        {deliveries.length === 0 ? (
          <p className="text-center text-gray-400 py-12 text-sm">
            Belum ada pengiriman terjadwal untuk tanggal ini
          </p>
        ) : (
          <div className="space-y-8">
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
