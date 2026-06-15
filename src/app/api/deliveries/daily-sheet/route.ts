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
    .select("*, customers(name, phone_number, area, sub_area, subcontractor_id, delivery_route, delivery_position), orders(portions_lunch, portions_dinner, portions_per_delivery, meal_time_preference)")
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
  const dayOfWeek = targetDate.getDay(); // 0=Sun, 6=Sat

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
      cancel?: boolean;
    }[];
  };

  const db = createAdminClient();

  // Pre-fetch subcontractor costs to avoid N+1 queries in the loop
  const { data: subcontractors } = await db
    .from("subcontractors")
    .select("id, cost_per_portion");
  const subCostMap = new Map<string, number>(
    (subcontractors ?? []).map((s) => [s.id, s.cost_per_portion ?? 0]),
  );

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
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "delivery_date,customer_id,meal_type" },
    ).select("id").single();

    // Record journals for non-skipped rows (quota deduction handled by nightly cron)
    if (!row.skip && upserted?.id) {
      const { data: ord } = await db
        .from("orders")
        .select("price_per_portion, addon_cost_per_portion")
        .eq("id", row.order_id)
        .single();

      // Revenue recognition: Dr Unearned Revenue / Cr Catering Revenue
      if (ord?.price_per_portion) {
        const revenueAmount = row.portions * ord.price_per_portion;
        createJournalEntry({
          description: `Revenue recognition ${body.date} ${row.meal_type}`,
          date: body.date,
          sourceType: "delivery",
          sourceId: upserted.id,
          lines: [
            { accountCode: "2100", debit: revenueAmount, credit: 0 },
            { accountCode: "4001", debit: 0, credit: revenueAmount },
          ],
        }).catch((err) => console.error("[delivery] revenue journal error:", err));
      }

      // COGS: Dr Subcontractor Cost / Cr Accounts Payable
      const subCost = row.subcontractor_id ? (subCostMap.get(row.subcontractor_id) ?? 0) : 0;
      const addonCost = ord?.addon_cost_per_portion ?? 0;
      const cogsAmount = row.portions * (subCost + addonCost);
      if (cogsAmount > 0) {
        createJournalEntry({
          description: `COGS ${body.date} ${row.meal_type}`,
          date: body.date,
          sourceType: "delivery_cogs",
          sourceId: upserted.id,
          lines: [
            { accountCode: "5001", debit: cogsAmount, credit: 0 },
            { accountCode: "2001", debit: 0, credit: cogsAmount },
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

export const dynamic = "force-dynamic";

// Helper: load deadline hour
export async function getDeadlineHour(): Promise<number> {
  const raw = await getSetting("order_deadline_hour");
  return Number.parseInt(raw) || 20;
}
