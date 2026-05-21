import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    subcontractor_id: string;
    off_date: string;
    reason?: string;
  };

  const db = createAdminClient();
  const { data, error } = await db
    .from("subcontractor_off_days")
    .insert({
      subcontractor_id: body.subcontractor_id,
      off_date: body.off_date,
      reason: body.reason ?? null,
      created_by: user.email,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { id } = await req.json() as { id: string };
  const today = new Date().toISOString().slice(0, 10);

  const db = createAdminClient();
  // Only allow deleting future off-days
  const { error } = await db
    .from("subcontractor_off_days")
    .delete()
    .eq("id", id)
    .gt("off_date", today);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
