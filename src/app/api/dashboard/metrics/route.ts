import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const today = todayStart.toISOString().split("T")[0];

  const timings: Record<string, number> = {};
  async function timed<T>(label: string, p: PromiseLike<T>): Promise<T> {
    const start = Date.now();
    try {
      return await p;
    } finally {
      timings[label] = Date.now() - start;
    }
  }

  const [
    activeRes,
    deliveriesRes,
    pendingRes,
    revenueRes,
    pendingProofsRes,
    lapsedRes,
    chatbotRes,
  ] = await Promise.all([
    timed("active", db.from("orders").select("id", { count: "exact", head: true }).eq("status", "active")),
    timed(
      "deliveries",
      db
        .from("daily_deliveries")
        .select("id", { count: "exact", head: true })
        .eq("delivery_date", today)
        .neq("status", "skipped"),
    ),
    timed(
      "pending",
      db
        .from("orders")
        .select("id", { count: "exact", head: true })
        .in("status", ["pending_payment", "payment_proof_received"]),
    ),
    timed(
      "revenue",
      db
        .from("journal_lines")
        .select("credit, account:accounts!inner(code), journal:journals!inner(date, source_type)")
        .eq("account.code", "4001")
        .eq("journal.date", today)
        .eq("journal.source_type", "delivery"),
    ),
    timed(
      "proofs",
      db
        .from("delivery_proofs")
        .select("id", { count: "exact", head: true })
        .eq("status", "needs_review"),
    ),
    timed(
      "lapsed",
      db
        .from("customer_state")
        .select("id", { count: "exact", head: true })
        .eq("state", "lapsed"),
    ),
    timed(
      "chatbot",
      db.from("settings").select("value").eq("key", "chatbot_enabled").single(),
    ),
  ]);

  console.log("[dashboard/metrics] timings (ms):", timings);

  const revenueToday = (revenueRes.data ?? []).reduce(
    (sum, o) => sum + (o.credit ?? 0),
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
