import { type NextRequest, NextResponse } from "next/server";
import { createJournalEntry } from "@/lib/accounting/journal";
import { deleteDelivery } from "@/lib/orders/delivery-state";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  if (!date)
    return NextResponse.json(
      { ok: false, error: "date required" },
      { status: 400 },
    );

  const db = createAdminClient();

  // Load existing daily_deliveries for this date
  const { data: rows } = await db
    .from("daily_deliveries")
    .select(
      "*, customers(name, phone_number, area, sub_area, address, google_maps_link, address_2, area_2, sub_area_2, google_maps_link_2, subcontractor_id, delivery_route, delivery_position), orders(portions_lunch, portions_dinner, portions_per_delivery, size)",
    )
    .eq("delivery_date", date);

  return NextResponse.json({ ok: true, data: rows ?? [] });
}

// Save: upsert the day's rows. Skipped and cancelled rows are deleted, not
// marked — a delivery row means the food is being cooked, so the only way to
// say "not this one" is for the row not to be there.
export async function PUT(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = (await req.json()) as {
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

  // A delivery must draw from an order. Rows saved without one looked fine on
  // the sheet but silently skipped both the order deduction (below) and the
  // revenue/COGS journal, so the portions left and the books were both wrong
  // with nothing on screen to say so. 21 rows reached production this way,
  // entered on the sheet days before anyone keyed in the matching order.
  //
  // Reject the whole save rather than dropping the offending rows: a partial
  // write is harder to notice than a refusal, and the admin needs to go create
  // the order before this day's sheet means anything.
  const unbacked = body.rows.filter((r) => !r.cancel && !r.order_id);
  if (unbacked.length > 0) {
    const { data: who } = await db
      .from("customers")
      .select("name")
      .in(
        "id",
        unbacked.map((r) => r.customer_id),
      );
    const names = [...new Set((who ?? []).map((c) => c.name ?? "?"))].join(
      ", ",
    );
    return NextResponse.json(
      {
        ok: false,
        error: `Belum ada order aktif untuk: ${names}. Buat ordernya dulu, baru isi pengiriman.`,
      },
      { status: 400 },
    );
  }

  // Pre-fetch subcontractor costs to avoid N+1 queries in the loop
  const { data: rawSubs } = await db
    .from("subcontractors")
    .select("id, cost_per_portion, cost_per_portion_route1");
  const subcontractors = rawSubs ?? [];
  const subCostMap = new Map<string, number>(
    subcontractors.map((s) => [s.id, s.cost_per_portion ?? 0]),
  );
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
    // Skip and cancel are the same act: take the row off the sheet. Both used
    // to write a status ('skipped' / 'cancelled') and leave the row in place,
    // which meant every reader downstream had to remember to exclude it — and
    // two of them already disagreed about which values to exclude.
    if (row.cancel || row.skip) {
      const { data: existing } = await db
        .from("daily_deliveries")
        .select("id, quota_deducted, portions")
        .eq("delivery_date", body.date)
        .eq("customer_id", row.customer_id)
        .eq("meal_type", row.meal_type)
        .maybeSingle();
      if (!existing) continue;

      // The order needs nothing back: its balance is package_size minus its
      // rows, so removing the row is the refund. The customer-level counter is
      // a different, still-stored number and does have to be put back.
      if (existing.quota_deducted) {
        const { data: cust } = await db
          .from("customers")
          .select("portions_remaining")
          .eq("id", row.customer_id)
          .single();
        if (cust) {
          await db
            .from("customers")
            .update({
              portions_remaining: cust.portions_remaining + existing.portions,
            })
            .eq("id", row.customer_id);
        }
      }

      await deleteDelivery({
        db,
        id: existing.id,
        actor: user.email ?? "",
        reason: row.cancel ? "daily sheet cancel" : "daily sheet skip",
      });
      continue;
    }

    const { data: upserted } = await db
      .from("daily_deliveries")
      .upsert(
        {
          delivery_date: body.date,
          customer_id: row.customer_id,
          order_id: row.order_id,
          meal_type: row.meal_type,
          portions: row.portions,
          subcontractor_id: row.subcontractor_id,
          notes: row.notes,
          address_slot: row.address_slot ?? 1,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "delivery_date,customer_id,meal_type" },
      )
      .select("id")
      .single();

    // Journals created after the loop, one per meal_type per day.
    if (upserted?.id && row.order_id) {
      const { data: ord } = await db
        .from("orders")
        .select("price_per_portion, addon_cost_per_portion")
        .eq("id", row.order_id)
        .single();

      if (ord?.price_per_portion) {
        const mealType = row.meal_type;
        const lines = journalAccum.get(mealType) ?? [];
        if (lines.length === 0) journalAccum.set(mealType, lines);
        lines.push({
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
        revenueByRate.set(
          e.pricePerPortion,
          (revenueByRate.get(e.pricePerPortion) ?? 0) + e.portions,
        );
      }
      const totalRevenue = [...revenueByRate.entries()].reduce(
        (s, [price, p]) => s + price * p,
        0,
      );
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
        }).catch((err) =>
          console.error("[delivery] revenue journal error:", err),
        );
      }

      // COGS: group by effective cost per portion (route-aware)
      const cogsByRate = new Map<number, number>();
      for (const e of entries) {
        const subId = e.subcontractorId;
        const baseCost = subId ? (subCostMap.get(subId) ?? 0) : 0;
        const route1Cost = subId ? (subCostRoute1Map.get(subId) ?? null) : null;
        const route = routeMap.get(e.customerId);
        const subCost =
          route1Cost !== null && route === "1" ? route1Cost : baseCost;
        const totalRate = subCost + e.addonCostPerPortion;
        if (totalRate > 0) {
          cogsByRate.set(
            totalRate,
            (cogsByRate.get(totalRate) ?? 0) + e.portions,
          );
        }
      }
      const totalCogs = [...cogsByRate.entries()].reduce(
        (s, [rate, p]) => s + rate * p,
        0,
      );
      if (totalCogs > 0) {
        const totalCogsPortions = [...cogsByRate.values()].reduce(
          (s, p) => s + p,
          0,
        );
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const body = (await req.json()) as { id?: string };
  const id = body.id?.trim();
  if (!id)
    return NextResponse.json(
      { ok: false, error: "Missing id" },
      { status: 400 },
    );

  const db = createAdminClient();
  // deleteDelivery snapshots the whole row into edit_log first. This used to
  // log `changes: {}`, so a row deleted by mistake was gone with no record of
  // what it had been — and now that a skip is a delete, that is the only copy.
  try {
    const removed = await deleteDelivery({
      db,
      id,
      actor: user.email ?? "",
      reason: "daily sheet delete",
    });
    if (!removed)
      return NextResponse.json(
        { ok: false, error: "Not found" },
        { status: 404 },
      );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";

// Helper: load deadline hour. Re-exported from the delivery module so there is
// one reader and one fallback; the copy that lived here defaulted to 20:00
// while cron/cancel-unpaid defaulted to 16:00.
export { loadDeadlineHour as getDeadlineHour } from "@/lib/orders/delivery-state";
