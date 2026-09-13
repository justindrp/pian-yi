import { type NextRequest, NextResponse } from "next/server";
import { accrueDeliveryDate } from "@/lib/accounting/accrue-deliveries";
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

    // What the existing row was worth, if it is an existing row. A package can
    // be split across kitchens now, and an away day carries its own rate — the
    // upsert below replaces the whole row, so a rate not carried forward here
    // is a rate silently reset to the order's, which is the wrong money.
    const { data: priorRow } = await db
      .from("daily_deliveries")
      .select("price_per_portion")
      .eq("delivery_date", body.date)
      .eq("customer_id", row.customer_id)
      .eq("meal_type", row.meal_type)
      .maybeSingle();

    await db.from("daily_deliveries").upsert(
      {
        delivery_date: body.date,
        customer_id: row.customer_id,
        order_id: row.order_id,
        meal_type: row.meal_type,
        portions: row.portions,
        subcontractor_id: row.subcontractor_id,
        price_per_portion: priorRow?.price_per_portion ?? null,
        notes: row.notes,
        address_slot: row.address_slot ?? 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "delivery_date,customer_id,meal_type" },
    );
  }

  // Recognise the day into the books off the rows themselves, not off this
  // payload. Idempotent, so a second Save posts nothing; the nightly cron
  // (`/api/cron/accrue-deliveries`) catches every date nobody saved by hand,
  // which since 21 Agustus 2026 was all of them.
  await accrueDeliveryDate(db, body.date).catch((err) =>
    console.error("[delivery] accrual error:", err),
  );

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
