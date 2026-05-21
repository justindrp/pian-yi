import { type NextRequest, NextResponse } from "next/server";
import { invalidateCache } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const db = createAdminClient();
  const { data, error } = await db
    .from("chatbot_instructions")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as { instruction: string; description?: string };
  const db = createAdminClient();

  const { data, error } = await db
    .from("chatbot_instructions")
    .insert({
      instruction: body.instruction,
      description: body.description ?? null,
      created_by: user.email,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  invalidateCache();
  return NextResponse.json({ ok: true, data });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    id: string;
    instruction?: string;
    description?: string;
    is_active?: boolean;
  };

  const db = createAdminClient();
  const { id, ...fields } = body;
  const { data, error } = await db
    .from("chatbot_instructions")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  invalidateCache();
  return NextResponse.json({ ok: true, data });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { id } = await req.json() as { id: string };
  const db = createAdminClient();
  const { error } = await db.from("chatbot_instructions").delete().eq("id", id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  invalidateCache();
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
