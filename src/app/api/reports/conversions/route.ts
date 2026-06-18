import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
  const perPage = Number(searchParams.get("perPage") ?? "20");
  const exportAll = searchParams.get("export") === "true";

  const db = createAdminClient();

  // Fetch all conversions for summary stats (no pagination needed — dataset is small)
  let allQuery = db
    .from("customers")
    .select(
      "id, name, area, ad_creative, package, total_portions, total_payment, promo_used, converted_to_subscription, notes, converted_at",
    )
    .not("converted_at", "is", null)
    .order("converted_at", { ascending: false });

  if (startDate) allQuery = allQuery.gte("converted_at", startDate);
  if (endDate) allQuery = allQuery.lte("converted_at", `${endDate}T23:59:59Z`);

  const { data: allRows, error } = await allQuery;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const rows = allRows ?? [];

  // Summary stats
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const thisMonth = rows.filter((r) => r.converted_at! >= monthStart);

  const totalRevenue = rows.reduce((sum, r) => sum + (r.total_payment ?? 0), 0);
  const revenueThisMonth = thisMonth.reduce((sum, r) => sum + (r.total_payment ?? 0), 0);

  // Per-creative breakdown
  const creativeMap = new Map<
    string,
    { conversions: number; revenue: number; subscribed: number }
  >();
  for (const r of rows) {
    const key = r.ad_creative ?? "Organic";
    const entry = creativeMap.get(key) ?? { conversions: 0, revenue: 0, subscribed: 0 };
    entry.conversions += 1;
    entry.revenue += r.total_payment ?? 0;
    if (r.converted_to_subscription) entry.subscribed += 1;
    creativeMap.set(key, entry);
  }
  const byCreative = Array.from(creativeMap.entries())
    .map(([creative, s]) => ({
      creative,
      conversions: s.conversions,
      revenue: s.revenue,
      avgOrderValue: s.conversions > 0 ? Math.round(s.revenue / s.conversions) : 0,
      subscribed: s.subscribed,
      subscriptionRate:
        s.conversions > 0 ? Math.round((s.subscribed / s.conversions) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.conversions - a.conversions);

  const topCreative = byCreative.find((c) => c.creative !== "Organic")?.creative ?? null;
  const organicConversions = rows.filter((r) => !r.ad_creative).length;

  if (exportAll) {
    return NextResponse.json({
      ok: true,
      data: {
        totalConversions: rows.length,
        conversionsThisMonth: thisMonth.length,
        totalRevenue,
        revenueThisMonth,
        topCreative,
        organicConversions,
        byCreative,
        log: rows,
        total: rows.length,
        page: 1,
      },
    });
  }

  // Paginated log
  const total = rows.length;
  const log = rows.slice((page - 1) * perPage, page * perPage);

  return NextResponse.json({
    ok: true,
    data: {
      totalConversions: rows.length,
      conversionsThisMonth: thisMonth.length,
      totalRevenue,
      revenueThisMonth,
      topCreative,
      organicConversions,
      byCreative,
      log,
      total,
      page,
    },
  });
}

export const dynamic = "force-dynamic";
