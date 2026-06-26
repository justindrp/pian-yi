import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole } from "@/lib/supabase/get-role";
import { createConversation, listConversations } from "@/lib/claude/assistant-history";

export async function GET() {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  const data = await listConversations(db);
  return NextResponse.json({ ok: true, data });
}

export async function POST() {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  const id = await createConversation(db);
  if (!id) {
    return NextResponse.json({ ok: false, error: "Failed to create conversation" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, data: { id } });
}

export const dynamic = "force-dynamic";
