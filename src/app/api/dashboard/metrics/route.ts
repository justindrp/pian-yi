import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const today = todayStart.toISOString().split("T")[0];

  const [
    activeRes,
    deliveriesRes,
    pendingRes,
    revenueRes,
    pendingProofsRes,
    lapsedRes,
    chatbotRes,
  ] = await Promise.all([
    db.from("orders").select("id", { count: "exact", head: true }).eq("status", "active"),
    db
      .from("daily_deliveries")
      .select("id", { count: "exact", head: true })
      .eq("delivery_date", today)
      .neq("status", "skipped"),
    db
      .from("orders")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending_payment", "payment_proof_received"]),
    db
      .from("orders")
      .select("total_price")
      .gte("paid_at", todayStart.toISOString())
      .lte("paid_at", todayEnd.toISOString()),
    db
      .from("delivery_proofs")
      .select("id", { count: "exact", head: true })
      .eq("status", "needs_review"),
    db
      .from("customer_state")
      .select("id", { count: "exact", head: true })
      .eq("state", "lapsed"),
    db.from("settings").select("value").eq("key", "chatbot_enabled").single(),
  ]);

  const revenueToday = (revenueRes.data ?? []).reduce(
    (sum, o) => sum + (o.total_price ?? 0),
    0,
  );

  return NextResponse.json({
    ok: true,
    data: {
      activeCustomers: activeRes.count ?? 0,
      deliveriesToday: deliveriesRes.count ?? 0,
      pendingPayments: pendingRes.count ?? 0,
      revenueToday,
      pendingProofs: pendingProofsRes.count ?? 0,
      lapsedCustomers: lapsedRes.count ?? 0,
      chatbotEnabled: chatbotRes.data?.value === "true",
    },
  });
}
