import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");

  const db = createAdminClient();
  let query = db
    .from("orders")
    .select("*, customers(name, phone_number)")
    .order("created_at", { ascending: false })
    .limit(100);

  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    id: string;
    status: "active" | "pending_payment";
    cancellation_reason?: string;
  };
  if (!body.id || !body.status)
    return NextResponse.json(
      { ok: false, error: "Missing id or status" },
      { status: 400 },
    );

  const db = createAdminClient();
  const updates = {
    status: body.status,
    ...(body.status === "active" ? { paid_at: new Date().toISOString() } : {}),
    ...(body.cancellation_reason
      ? { cancellation_reason: body.cancellation_reason }
      : {}),
  };

  const { error } = await db.from("orders").update(updates).eq("id", body.id);
  if (error)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
