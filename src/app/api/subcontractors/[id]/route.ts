import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json() as {
    name?: string;
    customer_nickname?: string | null;
    admin_phone?: string;
    admin_phone_2?: string;
    delivery_areas?: string[];
    notes?: string;
    is_active?: boolean;
    cost_per_portion?: number;
    menu_text?: string | null;
  };

  const allowed: Record<string, unknown> = {};
  if (body.name !== undefined) allowed.name = body.name;
  if (body.customer_nickname !== undefined) allowed.customer_nickname = body.customer_nickname;
  if (body.admin_phone !== undefined) allowed.admin_phone = body.admin_phone;
  if (body.admin_phone_2 !== undefined) allowed.admin_phone_2 = body.admin_phone_2;
  if (body.delivery_areas !== undefined) allowed.delivery_areas = body.delivery_areas;
  if (body.notes !== undefined) allowed.notes = body.notes;
  if (body.is_active !== undefined) allowed.is_active = body.is_active;
  if (body.cost_per_portion !== undefined) allowed.cost_per_portion = body.cost_per_portion;
  if (body.menu_text !== undefined) allowed.menu_text = body.menu_text;

  const db = createAdminClient();
  const { data, error } = await db
    .from("subcontractors")
    .update({ ...allowed, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}

export const dynamic = "force-dynamic";
