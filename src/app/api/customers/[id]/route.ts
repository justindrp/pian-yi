import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET — per-customer draw ledger: every package purchase (+N credit) and every
// daily delivery (−portions debit), chronological, with a running balance.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const db = createAdminClient();

  const [ordersRes, deliveriesRes] = await Promise.all([
    db
      .from("orders")
      .select("id, package_size, total_price, price_per_portion, start_date, created_at, status")
      .eq("customer_id", id),
    db
      .from("daily_deliveries")
      .select("id, delivery_date, meal_type, portions, status, notes")
      .eq("customer_id", id),
  ]);

  if (ordersRes.error) {
    return NextResponse.json({ ok: false, error: ordersRes.error.message }, { status: 500 });
  }
  if (deliveriesRes.error) {
    return NextResponse.json({ ok: false, error: deliveriesRes.error.message }, { status: 500 });
  }

  const today = new Date().toISOString().slice(0, 10);

  type Entry = {
    id: string;
    kind: "package" | "draw";
    date: string;
    label: string;
    meal_type: string | null;
    change: number;
    status: string | null;
    scheduled: boolean;
  };

  const entries: Entry[] = [];

  for (const o of ordersRes.data ?? []) {
    const date = (o.start_date ?? o.created_at ?? "").slice(0, 10);
    entries.push({
      id: `pkg-${o.id}`,
      kind: "package",
      date,
      label: `Paket ${o.package_size ?? 0} porsi`,
      meal_type: null,
      change: o.package_size ?? 0,
      status: o.status,
      scheduled: false,
    });
  }

  for (const d of deliveriesRes.data ?? []) {
    const date = (d.delivery_date ?? "").slice(0, 10);
    entries.push({
      id: `draw-${d.id}`,
      kind: "draw",
      date,
      label: d.notes ? String(d.notes) : "",
      meal_type: d.meal_type,
      change: -(d.portions ?? 0),
      status: d.status,
      scheduled: date > today,
    });
  }

  // Chronological: by date, then package credits before draws on the same date,
  // then lunch before dinner.
  const mealRank = (m: string | null) => (m === "dinner" ? 1 : 0);
  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "package" ? -1 : 1;
    return mealRank(a.meal_type) - mealRank(b.meal_type);
  });

  let balance = 0;
  const rows = entries.map((e) => {
    balance += e.change;
    return { ...e, balance };
  });

  const totalPackage = rows.filter((r) => r.kind === "package").reduce((s, r) => s + r.change, 0);
  const totalDrawn = rows.filter((r) => r.kind === "draw").reduce((s, r) => s + r.change, 0); // negative

  return NextResponse.json({
    ok: true,
    data: { rows, totalPackage, totalDrawn, balance },
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { id } = await params;
  const body = (await req.json()) as { name?: string; notes?: string };
  const update: { name?: string; notes?: string } = {};
  if (body.name !== undefined) update.name = body.name.trim();
  if (body.notes !== undefined) update.notes = body.notes;

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { ok: false, error: "Nothing to update" },
      { status: 400 },
    );
  }
  if ("name" in update && !update.name) {
    return NextResponse.json(
      { ok: false, error: "Missing name" },
      { status: 400 },
    );
  }

  const db = createAdminClient();
  const { error } = await db.from("customers").update(update).eq("id", id);
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { id } = await params;
  const db = createAdminClient();

  // Preserve delivery_proofs audit rows by detaching them first (FK has no
  // cascade, so a delete would fail). matched_customer_id becomes NULL.
  const detachProofs = await db
    .from("delivery_proofs")
    .update({ matched_customer_id: null })
    .eq("matched_customer_id", id);
  if (detachProofs.error) {
    return NextResponse.json(
      { ok: false, error: detachProofs.error.message },
      { status: 500 },
    );
  }

  // daily_deliveries and orders FKs have no ON DELETE — delete explicitly.
  const delDeliveries = await db
    .from("daily_deliveries")
    .delete()
    .eq("customer_id", id);
  if (delDeliveries.error) {
    return NextResponse.json(
      { ok: false, error: delDeliveries.error.message },
      { status: 500 },
    );
  }

  const delOrders = await db.from("orders").delete().eq("customer_id", id);
  if (delOrders.error) {
    return NextResponse.json(
      { ok: false, error: delOrders.error.message },
      { status: 500 },
    );
  }

  // customers cascades to customer_state, customer_flags, customer_rate_limits,
  // and conversations. processed_messages / edit_log / conversation_logs are
  // audit tables and remain intact.
  const delCustomer = await db.from("customers").delete().eq("id", id);
  if (delCustomer.error) {
    return NextResponse.json(
      { ok: false, error: delCustomer.error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
