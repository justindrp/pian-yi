import { NextResponse } from "next/server";
import { logEdit } from "@/lib/audit/log-edit";
import { packageCreditDate } from "@/lib/orders/credit-date";
import { createAdminClient } from "@/lib/supabase/admin";
import { withDeliveryRoute } from "@/lib/utils/format";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export const dynamic = "force-dynamic";

// GET — per-customer draw ledger: every package purchase (+N credit) and every
// daily delivery (−portions debit), chronological, with a running balance.
// Returns two totals: balanceToday (draws up to today) and balance (all draws,
// including deliveries already scheduled ahead).
export async function GET(
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

  const [ordersRes, deliveriesRes] = await Promise.all([
    db
      .from("orders")
      .select(
        "id, package_size, total_price, price_per_portion, start_date, created_at, status, source, grant_reason",
      )
      .eq("customer_id", id)
      .in("status", [
        "active",
        "paused",
        "completed",
        "payment_proof_received",
      ]),
    db
      .from("daily_deliveries")
      .select("id, delivery_date, meal_type, portions, status, notes")
      .eq("customer_id", id),
  ]);

  if (ordersRes.error) {
    return NextResponse.json(
      { ok: false, error: ordersRes.error.message },
      { status: 500 },
    );
  }
  if (deliveriesRes.error) {
    return NextResponse.json(
      { ok: false, error: deliveriesRes.error.message },
      { status: 500 },
    );
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
    const date = packageCreditDate(o);
    entries.push({
      id: `pkg-${o.id}`,
      kind: "package",
      date,
      label:
        o.source === "free_quota"
          ? `Kuota gratis: ${o.grant_reason ?? "-"}`
          : `Paket ${o.package_size ?? 0} porsi`,
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

  const totalPackage = rows
    .filter((r) => r.kind === "package")
    .reduce((s, r) => s + r.change, 0);
  const totalDrawn = rows
    .filter((r) => r.kind === "draw")
    .reduce((s, r) => s + r.change, 0); // negative

  // Two balances, because they answer different questions and admins need both.
  //
  // balanceToday — draws dated today or earlier only. What the customer has
  // left right now, so it is the number to compare against a physical count or
  // against customers.portions_remaining when hunting a mismatch.
  //
  // balance — every draw, including deliveries already booked for future dates.
  // What the customer will have once the current schedule finishes running, so
  // it is the number that says whether they need to top up.
  //
  // Package credits count in both: quota is paid for and usable from the moment
  // the order exists, even when start_date is still ahead.
  const balanceToday = rows.reduce(
    (s, r) => (r.scheduled ? s : s + r.change),
    0,
  );

  return NextResponse.json({
    ok: true,
    data: { rows, totalPackage, totalDrawn, balance, balanceToday },
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
  const body = (await req.json()) as Record<string, unknown>;

  // Allowlist. The Customers screen used to write these columns straight from
  // the browser with the user-scoped client, which meant an edit landed with no
  // record of who made it — the same screen where an address, an area or a
  // contract rate gets changed. Everything it edits now comes through here.
  // Money and quota columns are deliberately absent: total_payment,
  // total_portions and portions_remaining are server-derived.
  const TEXT_FIELDS = [
    "phone_number",
    "name",
    "address",
    "area",
    "sub_area",
    "subcontractor_id",
    "address_type",
    "delivery_phone",
    "google_maps_link",
    "meal_time_preference",
    "ad_creative",
    "promo_used",
    "notes",
    "address_2",
    "area_2",
    "sub_area_2",
    "google_maps_link_2",
    "linked_order_id",
  ] as const;

  const update: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    if (body[field] === undefined) continue;
    const raw = body[field];
    const trimmed = raw === null ? null : String(raw).trim();
    update[field] = trimmed || null;
  }
  if (body.converted_to_subscription !== undefined)
    update.converted_to_subscription = Boolean(body.converted_to_subscription);
  if (body.delivery_route !== undefined)
    update.delivery_route =
      body.delivery_route === null ? null : Number(body.delivery_route);
  // A corporate rate; null restores ordinary tier pricing.
  if (body.contract_price_per_portion !== undefined)
    update.contract_price_per_portion =
      body.contract_price_per_portion === null ||
      Number(body.contract_price_per_portion) <= 0
        ? null
        : Number(body.contract_price_per_portion);

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
  if ("phone_number" in update && !update.phone_number) {
    return NextResponse.json(
      { ok: false, error: "Missing phone_number" },
      { status: 400 },
    );
  }
  update.updated_at = new Date().toISOString();

  const db = createAdminClient();
  const { error } = await db
    .from("customers")
    .update(
      withDeliveryRoute(
        update,
      ) as Database["public"]["Tables"]["customers"]["Update"],
    )
    .eq("id", id);
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  await logEdit({
    db,
    actor: user.email ?? "",
    entityType: "customers",
    entityId: id,
    action: "update",
    changes: update,
  });

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

  // Everything else about this customer is now gone — their orders, deliveries
  // and conversations included. This line is the record that it was deliberate.
  await logEdit({
    db,
    actor: user.email ?? "",
    entityType: "customers",
    entityId: id,
    action: "delete",
    changes: {
      deleted_customer_id: id,
      cascaded: ["orders", "daily_deliveries", "conversations"],
    },
  });

  return NextResponse.json({ ok: true });
}
