import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getDeliveryRoute } from "@/lib/utils/format";

export async function GET(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const db = createAdminClient();
  const all = new URL(req.url).searchParams.get("all") === "true";

  const columns =
    "id, name, phone_number, area, sub_area, address, address_2, subcontractor_id, linked_order_id";

  // `?all=true` returns every customer (e.g. the new-order modal, which must let
  // an admin start the first order for a just-created customer who has no paid
  // order yet). The default lists only customers who have ordered AND paid: at
  // least one order in a paid-onward status (proof received / active / paused /
  // completed). Leads and unpaid (pending_payment) or cancelled do not surface.
  if (all) {
    const { data, error } = await db
      .from("customers")
      .select(columns)
      .order("name");
    if (error)
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    // Attach each customer's own active order id, so the UI can offer
    // "draw from another customer's balance" without a separate lookup.
    const { data: activeOrders } = await db
      .from("orders")
      .select("id, customer_id")
      .in("status", ["active", "paused"]);
    const activeOrderByCustomer = new Map(
      (activeOrders ?? []).map((o) => [o.customer_id, o.id]),
    );
    const withActiveOrder = (data ?? []).map((c) => ({
      ...c,
      active_order_id: activeOrderByCustomer.get(c.id) ?? null,
    }));

    return NextResponse.json({ ok: true, data: withActiveOrder });
  }

  const PAID_STATUSES = [
    "payment_proof_received",
    "active",
    "paused",
    "completed",
  ];
  const { data: paidOrders } = await db
    .from("orders")
    .select("customer_id")
    .in("status", PAID_STATUSES);
  const paidCustomerIds = [
    ...new Set(
      (paidOrders ?? [])
        .map((o) => o.customer_id)
        .filter((id): id is string => id !== null),
    ),
  ];

  const { data, error } = await db
    .from("customers")
    .select(columns)
    .in("id", paidCustomerIds)
    .order("name");

  if (error)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}

// Create a new customer (e.g. someone who ordered a package manually via
// WhatsApp and needs to be onboarded into the dashboard). Allowlisted fields
// only; phone_number is required and must be unique.
export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    name?: string;
    phone_number?: string;
    area?: string;
    sub_area?: string;
    address?: string;
    address_2?: string;
    google_maps_link?: string;
    subcontractor_id?: string;
    linked_order_id?: string;
  };

  const phone = body.phone_number?.trim();
  if (!phone)
    return NextResponse.json({ ok: false, error: "phone_number required" }, { status: 400 });

  const address = body.address?.trim();
  if (!address)
    return NextResponse.json({ ok: false, error: "address required" }, { status: 400 });

  const db = createAdminClient();

  const { data: existing } = await db
    .from("customers")
    .select("id")
    .eq("phone_number", phone)
    .maybeSingle();
  if (existing)
    return NextResponse.json(
      { ok: false, error: "Pelanggan dengan nomor ini sudah ada", existingId: existing.id },
      { status: 409 },
    );

  const area = body.area?.trim() || null;
  const deliveryRoute = getDeliveryRoute(area);

  const { data, error } = await db
    .from("customers")
    .insert({
      phone_number: phone,
      name: body.name?.trim() || null,
      area,
      sub_area: body.sub_area?.trim() || null,
      address,
      address_2: body.address_2?.trim() || null,
      google_maps_link: body.google_maps_link?.trim() || null,
      subcontractor_id: body.subcontractor_id || null,
      linked_order_id: body.linked_order_id || null,
      delivery_route: deliveryRoute,
    })
    .select(
      "id, name, phone_number, area, sub_area, address, address_2, subcontractor_id, linked_order_id",
    )
    .single();

  if (error)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, data });
}

export const dynamic = "force-dynamic";
