import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

function getTomorrowWIB(): string {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  wib.setUTCDate(wib.getUTCDate() + 1);
  return wib.toISOString().slice(0, 10);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const date = new URL(req.url).searchParams.get("date") ?? getTomorrowWIB();

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

  if (!sub) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  const deliveries = rows ?? [];

  let lunchRute1 = 0,
    lunchRute2 = 0,
    dinnerRute1 = 0,
    dinnerRute2 = 0;

  for (const d of deliveries) {
    const customer = d.customers as { delivery_route?: number | null } | null;
    const route = customer?.delivery_route ?? 1;
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

  return NextResponse.json({
    ok: true,
    subcontractor: { id: sub.id, name: sub.name },
    date,
    summary: {
      total: lunch + dinner,
      lunch: { total: lunch, rute1: lunchRute1, rute2: lunchRute2 },
      dinner: { total: dinner, rute1: dinnerRute1, rute2: dinnerRute2 },
    },
    orders: deliveries.map((d) => ({
      id: d.id,
      meal_type: d.meal_type,
      portions: d.portions,
      notes: d.notes,
      customer: d.customers,
    })),
  });
}

export const dynamic = "force-dynamic";
