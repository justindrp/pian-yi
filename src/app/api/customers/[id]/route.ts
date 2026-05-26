import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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
