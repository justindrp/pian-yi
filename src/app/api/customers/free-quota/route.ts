import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";

// Batch-grant free/goodwill quota to customers (e.g. compensation for a late
// delivery). Each grant becomes its own Rp 0 orders row (source: "free_quota"),
// so it shows as a discrete +N line in the customer's ledger
// (GET /api/customers/[id]) rather than a silent balance adjustment.
export async function POST(req: Request): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as {
    grants?: { customer_id?: string; portions?: number; date?: string; reason?: string }[];
  };
  const grants = body.grants ?? [];
  if (grants.length === 0) {
    return NextResponse.json({ ok: false, error: "No grants provided" }, { status: 400 });
  }
  for (const g of grants) {
    if (!g.customer_id || !g.portions || g.portions <= 0 || !g.date || !g.reason?.trim()) {
      return NextResponse.json(
        { ok: false, error: "Each grant needs customer_id, portions > 0, date, and reason" },
        { status: 400 },
      );
    }
  }

  const db = createAdminClient();

  const customerIds = [...new Set(grants.map((g) => g.customer_id as string))];
  const { data: customers, error: customersError } = await db
    .from("customers")
    .select("id, portions_remaining")
    .in("id", customerIds);
  if (customersError) {
    return NextResponse.json({ ok: false, error: customersError.message }, { status: 500 });
  }
  const customerById = new Map((customers ?? []).map((c) => [c.id, c]));
  for (const id of customerIds) {
    if (!customerById.has(id)) {
      return NextResponse.json({ ok: false, error: `Customer ${id} not found` }, { status: 400 });
    }
  }

  const rows = grants.map((g) => {
    return {
      customer_id: g.customer_id as string,
      order_type: "scheduled" as const,
      status: "active" as const,
      price_per_portion: 0,
      total_price: 0,
      package_size: g.portions as number,
      portions_remaining: g.portions as number,
      portions_per_delivery: g.portions as number,
      start_date: g.date as string,
      source: "free_quota" as const,
      grant_reason: (g.reason as string).trim(),
      granted_by: session.email,
    };
  });

  const { data: inserted, error: insertError } = await db.from("orders").insert(rows).select("id");
  if (insertError) {
    return NextResponse.json({ ok: false, error: insertError.message }, { status: 500 });
  }

  const portionsByCustomer = new Map<string, number>();
  for (const g of grants) {
    const id = g.customer_id as string;
    portionsByCustomer.set(id, (portionsByCustomer.get(id) ?? 0) + (g.portions as number));
  }
  for (const [customerId, portions] of portionsByCustomer) {
    const customer = customerById.get(customerId);
    await db
      .from("customers")
      .update({ portions_remaining: (customer?.portions_remaining ?? 0) + portions })
      .eq("id", customerId);
  }

  await db.from("edit_log").insert({
    entity_type: "orders",
    entity_id: (inserted ?? []).map((o) => o.id).join(","),
    action: "grant_free_quota",
    changed_by: session.email,
    changes: { grants },
  });

  return NextResponse.json({ ok: true, data: { created: inserted?.length ?? 0 } });
}

export const dynamic = "force-dynamic";
