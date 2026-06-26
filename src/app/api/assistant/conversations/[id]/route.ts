import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { getMessages } from "@/lib/claude/assistant-history";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const db = createAdminClient();
  const data = await getMessages(db, id);
  return NextResponse.json({ ok: true, data });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  let body: { title?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const title = body.title?.trim();
  if (!title) {
    return NextResponse.json({ ok: false, error: "title required" }, { status: 400 });
  }
  const db = createAdminClient();
  const { error } = await db
    .from("assistant_conversations")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const db = createAdminClient();
  const { error } = await db.from("assistant_conversations").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
