import { type NextRequest, NextResponse } from "next/server";
import { createJournalEntry } from "@/lib/accounting/journal";
import { getSetting } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  if (!date) return NextResponse.json({ ok: false, error: "date required" }, { status: 400 });

  const db = createAdminClient();

  // Load existing daily_deliveries for this date
  const { data: rows } = await db
    .from("daily_deliveries")
    .select("*, customers(name, phone_number, area, sub_area, address, google_maps_link, address_2, area_2, sub_area_2, google_maps_link_2, subcontractor_id, delivery_route, delivery_position), orders(portions_lunch, portions_dinner, portions_per_delivery, meal_time_preference, size)")
    .eq("delivery_date", date);

  return NextResponse.json({ ok: true, data: rows ?? [] });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { date: string };
  const date = body.date;
  if (!date) return NextResponse.json({ ok: false, error: "date required" }, { status: 400 });

  const db = createAdminClient();

  // Load active orders that have started by the target date
  const { data: orders } = await db
    .from("orders")
    .select("id, customer_id, meal_time_preference, portions_lunch, portions_dinner, portions_per_delivery, pause_until, subcontractor_id, customers(name, phone_number, area, subcontractor_id)")
    .eq("status", "active")
    .eq("order_type", "recurring")
    .lte("start_date", date);

  if (!orders) return NextResponse.json({ ok: true, data: [] });

  const targetDate = new Date(date);

  const rows: {
    delivery_date: string;
    customer_id: string;
    order_id: string;
    meal_type: string;
    portions: number;
    subcontractor_id: string | null;
    status: string;
  }[] = [];

  for (const order of orders) {
    const customer = order.customers as { name: string | null; phone_number: string; area: string; subcontractor_id: string | null } | null;
    if (!customer) continue;
    const subcontractorId = (order as unknown as { subcontractor_id: string | null }).subcontractor_id ?? customer.subcontractor_id;
    if (!subcontractorId) continue;

    // Skip paused
    if (order.pause_until && new Date(order.pause_until) >= targetDate) continue;

    const pref = order.meal_time_preference;

    const isLunch = pref === "lunch_only" || pref === "both_fixed" || pref === "keduanya" || pref === "default_lunch" || pref === "per_day_decision";
    const isDinner = pref === "dinner_only" || pref === "both_fixed" || pref === "keduanya" || pref === "default_dinner" || pref === "per_day_decision";

    if (isLunch && !order.customer_id) continue;

    if (isLunch) {
      rows.push({
        delivery_date: date,
        customer_id: order.customer_id as string,
        order_id: order.id,
        meal_type: "lunch",
        portions: (order.portions_lunch ?? 0) > 0 ? (order.portions_lunch ?? 0) : order.portions_per_delivery,
        subcontractor_id: subcontractorId,
        status: "scheduled",
      });
    }

    if (isDinner) {
      rows.push({
        delivery_date: date,
        customer_id: order.customer_id as string,
        order_id: order.id,
        meal_type: "dinner",
        portions: (order.portions_dinner ?? 0) > 0 ? (order.portions_dinner ?? 0) : order.portions_per_delivery,
        subcontractor_id: subcontractorId,
        status: "scheduled",
      });
    }
  }

  // Upsert
  if (rows.length > 0) {
    await db.from("daily_deliveries").upsert(rows, {
      onConflict: "delivery_date,customer_id,meal_type",
      ignoreDuplicates: true,
    });
  }

  return NextResponse.json({ ok: true, data: rows });
}

// Save: upsert rows and deduct portions_remaining
export async function PUT(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    date: string;
    rows: {
      id?: string;
      customer_id: string;
      order_id: string;
      meal_type: string;
      portions: number;
      subcontractor_id: string | null;
      notes: string | null;
      skip: boolean;
      address_slot?: number;
      cancel?: boolean;
    }[];
  };

  const db = createAdminClient();

  // Pre-fetch subcontractor costs to avoid N+1 queries in the loop
  const { data: rawSubs } = await db
    .from("subcontractors")
    .select("id, cost_per_portion, cost_per_portion_route1");
  const subcontractors = rawSubs ?? [];
  const subCostMap = new Map<string, number>(subcontractors.map((s) => [s.id, s.cost_per_portion ?? 0]));
  const subCostRoute1Map = new Map<string, number | null>(
    subcontractors.map((s) => [s.id, s.cost_per_portion_route1 ?? null]),
  );

  // Accumulate per-meal journal data; journals created after loop (one per meal_type per day)
  type JournalAccum = {
    portions: number;
    pricePerPortion: number;
    addonCostPerPortion: number;
    subcontractorId: string | null;
    customerId: string;
  };
  const journalAccum = new Map<string, JournalAccum[]>(); // key: meal_type

  for (const row of body.rows) {
    // Cancellation path: reverse quota deduction if already processed
    if (row.cancel) {
      const { data: existing } = await db
        .from("daily_deliveries")
        .select("id, quota_deducted, portions, order_id")
        .eq("delivery_date", body.date)
        .eq("customer_id", row.customer_id)
        .eq("meal_type", row.meal_type)
        .single();

      if (existing?.quota_deducted) {
        const { data: cust } = await db
          .from("customers")
          .select("portions_remaining")
          .eq("id", row.customer_id)
          .single();
        if (cust) {
          await db
            .from("customers")
            .update({ portions_remaining: cust.portions_remaining + existing.portions })
            .eq("id", row.customer_id);
        }

        if (existing.order_id) {
          const { data: ord } = await db
            .from("orders")
            .select("portions_remaining")
            .eq("id", existing.order_id)
            .single();
          if (ord && ord.portions_remaining !== null) {
            await db
              .from("orders")
              .update({ portions_remaining: ord.portions_remaining + existing.portions })
              .eq("id", existing.order_id);
          }
        }

        await db
          .from("daily_deliveries")
          .update({ status: "cancelled", quota_deducted: false, updated_at: new Date().toISOString() })
          .eq("id", existing.id);
      } else if (existing) {
        await db
          .from("daily_deliveries")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("id", existing.id);
      }
      continue;
    }

    const status = row.skip ? "skipped" : "scheduled";
    const { data: upserted } = await db.from("daily_deliveries").upsert(
      {
        delivery_date: body.date,
        customer_id: row.customer_id,
        order_id: row.order_id,
        meal_type: row.meal_type,
        portions: row.portions,
        subcontractor_id: row.subcontractor_id,
        notes: row.notes,
        address_slot: row.address_slot ?? 1,
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "delivery_date,customer_id,meal_type" },
    ).select("id").single();

    // Accumulate journal data for non-skipped rows; journals created after loop
    if (!row.skip && upserted?.id && row.order_id) {
      const { data: ord } = await db
        .from("orders")
        .select("price_per_portion, addon_cost_per_portion")
        .eq("id", row.order_id)
        .single();

      if (ord?.price_per_portion) {
        const mealType = row.meal_type;
        if (!journalAccum.has(mealType)) journalAccum.set(mealType, []);
        journalAccum.get(mealType)!.push({
          portions: row.portions,
          pricePerPortion: ord.price_per_portion,
          addonCostPerPortion: ord.addon_cost_per_portion ?? 0,
          subcontractorId: row.subcontractor_id,
          customerId: row.customer_id,
        });
      }
    }
  }

  // Create one revenue + one COGS journal per meal_type (idempotent: skipped if already exists)
  if (journalAccum.size > 0) {
    const allEntries = [...journalAccum.values()].flat();
    const uniqueCustomerIds = [...new Set(allEntries.map((e) => e.customerId))];

    const { data: custRoutes } = await db
      .from("customers")
      .select("id, delivery_route")
      .in("id", uniqueCustomerIds);
    const routeMap = new Map<string, string | null>(
      (custRoutes ?? []).map((c) => [c.id, c.delivery_route as string | null]),
    );

    for (const [mealType, entries] of journalAccum.entries()) {
      // Revenue: group by price_per_portion
      const revenueByRate = new Map<number, number>();
      for (const e of entries) {
        revenueByRate.set(e.pricePerPortion, (revenueByRate.get(e.pricePerPortion) ?? 0) + e.portions);
      }
      const totalRevenue = [...revenueByRate.entries()].reduce((s, [price, p]) => s + price * p, 0);
      if (totalRevenue > 0) {
        const totalPortions = entries.reduce((s, e) => s + e.portions, 0);
        const revParts = [...revenueByRate.entries()]
          .sort(([a], [b]) => a - b)
          .map(([price, p]) => `${p}p × Rp${price.toLocaleString("id-ID")}`);
        createJournalEntry({
          description: `Revenue recognition ${body.date} ${mealType}`,
          date: body.date,
          sourceType: "delivery",
          sourceId: `rev_${body.date}_${mealType}`,
          notes: `${totalPortions} porsi: ${revParts.join(", ")} = Rp${totalRevenue.toLocaleString("id-ID")}`,
          lines: [
            { accountCode: "2100", debit: totalRevenue, credit: 0 },
            { accountCode: "4001", debit: 0, credit: totalRevenue },
          ],
        }).catch((err) => console.error("[delivery] revenue journal error:", err));
      }

      // COGS: group by effective cost per portion (route-aware)
      const cogsByRate = new Map<number, number>();
      for (const e of entries) {
        const subId = e.subcontractorId;
        const baseCost = subId ? (subCostMap.get(subId) ?? 0) : 0;
        const route1Cost = subId ? (subCostRoute1Map.get(subId) ?? null) : null;
        const route = routeMap.get(e.customerId);
        const subCost = route1Cost !== null && route === "1" ? route1Cost : baseCost;
        const totalRate = subCost + e.addonCostPerPortion;
        if (totalRate > 0) {
          cogsByRate.set(totalRate, (cogsByRate.get(totalRate) ?? 0) + e.portions);
        }
      }
      const totalCogs = [...cogsByRate.entries()].reduce((s, [rate, p]) => s + rate * p, 0);
      if (totalCogs > 0) {
        const totalCogsPortions = [...cogsByRate.values()].reduce((s, p) => s + p, 0);
        const cogsParts = [...cogsByRate.entries()]
          .sort(([a], [b]) => a - b)
          .map(([rate, p]) => `${p}p × Rp${rate.toLocaleString("id-ID")}`);
        createJournalEntry({
          description: `COGS ${body.date} ${mealType}`,
          date: body.date,
          sourceType: "delivery_cogs",
          sourceId: `cogs_${body.date}_${mealType}`,
          notes: `${totalCogsPortions} porsi: ${cogsParts.join(", ")} = Rp${totalCogs.toLocaleString("id-ID")}`,
          lines: [
            { accountCode: "5001", debit: totalCogs, credit: 0 },
            { accountCode: "2001", debit: 0, credit: totalCogs },
          ],
        }).catch((err) => console.error("[delivery] cogs journal error:", err));
      }
    }
  }

  await db.from("edit_log").insert({
    entity_type: "daily_deliveries",
    entity_id: body.date,
    action: "save_daily_sheet",
    changed_by: user.email ?? "",
    changes: { row_count: body.rows.length },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { id?: string };
  const id = body.id?.trim();
  if (!id) return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });

  const db = createAdminClient();
  // Detach delivery proofs (FK has no cascade) before removing the row.
  const detach = await db
    .from("delivery_proofs")
    .update({ matched_delivery_id: null })
    .eq("matched_delivery_id", id);
  if (detach.error) {
    return NextResponse.json({ ok: false, error: detach.error.message }, { status: 500 });
  }

  const { error } = await db.from("daily_deliveries").delete().eq("id", id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  await db.from("edit_log").insert({
    entity_type: "daily_deliveries",
    entity_id: id,
    action: "delete_delivery",
    changed_by: user.email ?? "",
    changes: {},
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";

// Helper: load deadline hour
export async function getDeadlineHour(): Promise<number> {
  const raw = await getSetting("order_deadline_hour");
  return Number.parseInt(raw ?? "20", 10) || 20;
}
