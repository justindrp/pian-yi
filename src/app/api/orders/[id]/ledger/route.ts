import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET — per-order draw ledger: the package credit (+package_size) followed by
// every daily_delivery that names this order, chronological, running balance.
//
// This is deliberately narrower than the customer ledger at
// /api/customers/[id], which sums every delivery a customer has regardless of
// which order it was charged to. That makes the customer view immune to
// misattribution — and therefore blind to it. Julian S's totals balanced
// perfectly there while four of his deliveries were charged to a package that
// was already empty. This view is where that shows up.
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

  const { data: order, error: orderErr } = await db
    .from("orders")
    .select(
      "id, customer_id, package_size, portions_remaining, start_date, created_at, status, source, grant_reason",
    )
    .eq("id", id)
    .maybeSingle();

  if (orderErr) {
    return NextResponse.json(
      { ok: false, error: orderErr.message },
      { status: 500 },
    );
  }
  if (!order) {
    return NextResponse.json(
      { ok: false, error: "Order not found" },
      { status: 404 },
    );
  }

  const { data: deliveries, error: delErr } = await db
    .from("daily_deliveries")
    .select("id, delivery_date, meal_type, portions, status, notes")
    .eq("order_id", id);

  if (delErr) {
    return NextResponse.json(
      { ok: false, error: delErr.message },
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

  const entries: Entry[] = [
    {
      id: `pkg-${order.id}`,
      kind: "package",
      // The day the package was bought, not the day it starts running. Dating
      // the credit by start_date put galvent's 19 August purchase on the 20th,
      // below deliveries that draw from it.
      date: (order.created_at ?? order.start_date ?? "").slice(0, 10),
      label:
        order.source === "free_quota"
          ? `Kuota gratis: ${order.grant_reason ?? "-"}`
          : `Paket ${order.package_size ?? 0} porsi`,
      meal_type: null,
      change: order.package_size ?? 0,
      status: order.status,
      scheduled: false,
    },
  ];

  for (const d of deliveries ?? []) {
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

  // Same ordering as the customer ledger: by date, credit before draw on the
  // same date, lunch before dinner. The package credit sorts first on its own
  // date, so a draw dated before the package start shows a negative running
  // balance from row one — which is the signal that it was charged too early.
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

  const totalDrawn = -rows
    .filter((r) => r.kind === "draw")
    .reduce((s, r) => s + r.change, 0);
  const packageSize = order.package_size ?? 0;

  // remaining is computed from this order's own draws, so it is the number to
  // compare against the stored orders.portions_remaining. A gap between them
  // means either a delivery is charged to the wrong order or the stored counter
  // drifted — both worth seeing, neither visible from the customer ledger.
  const remaining = packageSize - totalDrawn;

  return NextResponse.json({
    ok: true,
    data: {
      rows,
      packageSize,
      totalDrawn,
      remaining,
      storedRemaining: order.portions_remaining,
      // Draws dated on or before today only — what has actually been eaten out
      // of this package, ignoring deliveries already booked ahead.
      remainingToday: rows.reduce(
        (s, r) => (r.scheduled ? s : s + r.change),
        0,
      ),
    },
  });
}
