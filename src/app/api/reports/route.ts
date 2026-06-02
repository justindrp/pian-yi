import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const days = Number.parseInt(searchParams.get("days") ?? "30");
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const prevSince = new Date(Date.now() - days * 2 * 86400000).toISOString();

  const db = createAdminClient();

  const sinceDate = since.slice(0, 10);
  const prevSinceDate = prevSince.slice(0, 10);

  const [
    ordersRes,
    prevOrdersRes,
    customersRes,
    newCustomersRes,
    deliveriesRes,
    subcontractorsRes,
    conversationsRes,
    escalationsRes,
    revenueRes,
    prevRevenueRes,
    cogsRes,
  ] = await Promise.all([
    db.from("orders").select("total_price, portions_per_delivery, package_size, created_at, status").gte("created_at", since),
    db.from("orders").select("total_price, package_size").gte("created_at", prevSince).lt("created_at", since),
    db.from("customers").select("id, created_at, area"),
    db.from("customers").select("id").gte("created_at", since),
    db.from("daily_deliveries").select("delivery_date, subcontractor_id, status, meal_type, portions").gte("delivery_date", sinceDate),
    db.from("subcontractors").select("id, name, late_delivery_count, total_delivery_count"),
    db.from("conversations").select("role, input_tokens, output_tokens, model_used, created_at").gte("created_at", since),
    db.from("customer_flags").select("escalated_to_human").eq("escalated_to_human", true),
    // Recognized revenue: credits on account 4001 from delivery journals
    db.from("journal_lines")
      .select("credit, account:accounts!inner(code), journal:journals!inner(date, source_type)")
      .eq("account.code", "4001")
      .eq("journal.source_type", "delivery")
      .gte("journal.date", sinceDate),
    db.from("journal_lines")
      .select("credit, account:accounts!inner(code), journal:journals!inner(date, source_type)")
      .eq("account.code", "4001")
      .eq("journal.source_type", "delivery")
      .gte("journal.date", prevSinceDate)
      .lt("journal.date", sinceDate),
    // COGS: debits on account 5001 from delivery_cogs journals
    db.from("journal_lines")
      .select("debit, account:accounts!inner(code), journal:journals!inner(date, source_type)")
      .eq("account.code", "5001")
      .eq("journal.source_type", "delivery_cogs")
      .gte("journal.date", sinceDate),
  ]);

  const orders = ordersRes.data ?? [];
  const prevOrders = prevOrdersRes.data ?? [];
  const customers = customersRes.data ?? [];
  const deliveries = deliveriesRes.data ?? [];
  const subcontractors = subcontractorsRes.data ?? [];
  const conversations = conversationsRes.data ?? [];

  // Recognized revenue and COGS from journal lines
  const revenue = (revenueRes.data ?? []).reduce((sum, r) => sum + (r.credit ?? 0), 0);
  const prevRevenue = (prevRevenueRes.data ?? []).reduce((sum, r) => sum + (r.credit ?? 0), 0);
  const cogs = (cogsRes.data ?? []).reduce((sum, r) => sum + (r.debit ?? 0), 0);
  const grossProfit = revenue - cogs;

  // Portions
  const totalPortions = deliveries.filter(d => d.status !== "skipped" && d.status !== "not_delivered").reduce((sum, d) => sum + (d.portions ?? 0), 0);

  // Customers
  const activeCustomers = customers.filter(c => orders.some(o => o.status === "active")).length;

  // By area
  const revenueByArea: Record<string, number> = {};
  // (simplified — would need join with orders)

  // Subcontractor stats
  const subStats = subcontractors.map(s => {
    const sub_deliveries = deliveries.filter(d => d.subcontractor_id === s.id);
    const late = sub_deliveries.filter(d => d.status === "delivered_late").length;
    const total = sub_deliveries.filter(d => d.status !== "scheduled" && d.status !== "skipped").length;
    return {
      id: s.id,
      name: s.name,
      total_deliveries: total,
      late_deliveries: late,
      on_time_rate: total > 0 ? Math.round(((total - late) / total) * 100) : null,
    };
  });

  // AI cost
  const sonnetMessages = conversations.filter(c => c.model_used === "sonnet-4-6");
  const haikuMessages = conversations.filter(c => c.model_used?.includes("haiku"));
  const sonnetInputTokens = sonnetMessages.reduce((s, c) => s + (c.input_tokens ?? 0), 0);
  const sonnetOutputTokens = sonnetMessages.reduce((s, c) => s + (c.output_tokens ?? 0), 0);
  const haikuInputTokens = haikuMessages.reduce((s, c) => s + (c.input_tokens ?? 0), 0);
  const haikuOutputTokens = haikuMessages.reduce((s, c) => s + (c.output_tokens ?? 0), 0);
  const aiCost =
    (sonnetInputTokens * 3) / 1_000_000 +
    (sonnetOutputTokens * 15) / 1_000_000 +
    (haikuInputTokens * 0.8) / 1_000_000 +
    (haikuOutputTokens * 4) / 1_000_000;

  // Portions per day (last 30 days)
  const portionsByDay: Record<string, number> = {};
  for (const d of deliveries) {
    if (!d.delivery_date) continue;
    portionsByDay[d.delivery_date] = (portionsByDay[d.delivery_date] ?? 0) + (d.portions ?? 0);
  }

  const totalConversations = new Set(conversations.map(c => c.created_at?.slice(0, 10))).size;
  const escalationCount = escalationsRes.data?.length ?? 0;

  return NextResponse.json({
    ok: true,
    data: {
      revenue,
      prevRevenue,
      grossProfit,
      justinShare: Math.round(grossProfit * 0.6),
      annieShare: Math.round(grossProfit * 0.4),
      totalPortions,
      activeCustomers,
      newCustomers: newCustomersRes.data?.length ?? 0,
      avgOrderValue: orders.length > 0 ? Math.round(revenue / orders.length) : 0,
      subcontractorStats: subStats,
      portionsByDay,
      aiCost: Math.round(aiCost * 100) / 100,
      sonnetInputTokens,
      sonnetOutputTokens,
      haikuInputTokens,
      haikuOutputTokens,
      escalationRate: totalConversations > 0 ? Math.round((escalationCount / totalConversations) * 100) : 0,
      revenueByArea,
    },
  });
}

export const dynamic = "force-dynamic";
