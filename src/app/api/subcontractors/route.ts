import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const db = createAdminClient();
  const { data, error } = await db
    .from("subcontractors")
    .select("*, subcontractor_off_days(off_date, reason, id)")
    .order("name");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    name: string;
    admin_phone?: string;
    admin_phone_2?: string;
    delivery_areas?: string[];
    notes?: string;
  };

  const db = createAdminClient();
  const { data, error } = await db
    .from("subcontractors")
    .insert({
      name: body.name,
      admin_phone: body.admin_phone ?? null,
      admin_phone_2: body.admin_phone_2 ?? null,
      delivery_areas: body.delivery_areas ?? [],
      notes: body.notes ?? null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}

export const dynamic = "force-dynamic";
