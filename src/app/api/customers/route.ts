import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const db = createAdminClient();

  // Only list customers who have ordered AND paid: at least one order in a
  // paid-onward status (proof received / active / paused / completed). Leads and
  // unpaid (pending_payment) or cancelled orders do not surface here.
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
    .select("id, name, phone_number, area, sub_area, address, subcontractor_id")
    .in("id", paidCustomerIds)
    .order("name");

  if (error)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}

export const dynamic = "force-dynamic";
