import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const page = Number(searchParams.get("page") ?? "1");
  const limit = 20;
  const from = (page - 1) * limit;

  const db = createAdminClient();

  const { data: broadcasts, count } = await db
    .from("broadcasts")
    .select("*, broadcast_recipients(id, customer_id, phone_number, personalized_message, status, error, sent_at, customers(name, area))", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);

  return NextResponse.json({ ok: true, data: broadcasts ?? [], total: count ?? 0 });
}

export const dynamic = "force-dynamic";
