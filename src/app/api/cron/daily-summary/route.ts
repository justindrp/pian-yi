import { type NextRequest, NextResponse } from "next/server";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStart = new Date(yesterday.setHours(0, 0, 0, 0)).toISOString();
  const yEnd = new Date(yesterday.setHours(23, 59, 59, 999)).toISOString();

  const [ordersRes, paidRes, customersRes] = await Promise.all([
    db
      .from("orders")
      .select("id", { count: "exact" })
      .gte("created_at", yStart)
      .lte("created_at", yEnd),
    db
      .from("orders")
      .select("total_price")
      .gte("paid_at", yStart)
      .lte("paid_at", yEnd),
    db
      .from("customers")
      .select("id", { count: "exact" })
      .gte("created_at", yStart)
      .lte("created_at", yEnd),
  ]);

  const revenue = (paidRes.data ?? []).reduce(
    (sum, o) => sum + o.total_price,
    0,
  );
  const formattedRevenue = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(revenue);

  const body = [
    `Orders created: ${ordersRes.count ?? 0}`,
    `Orders paid: ${paidRes.data?.length ?? 0}`,
    `Revenue: ${formattedRevenue}`,
    `New customers: ${customersRes.count ?? 0}`,
  ].join(" | ");

  const dateStr = new Date(yStart).toLocaleDateString("id-ID", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  await sendPushToAllAdmins(`Daily Summary — ${dateStr}`, body, "/", "low");

  return NextResponse.json({ ok: true });
}
