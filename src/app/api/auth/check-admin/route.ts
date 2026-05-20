import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest): Promise<Response> {
  const { email } = (await req.json()) as { email: string };

  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  const db = createAdminClient();
  const { data } = await db
    .from("admin_users")
    .select("email")
    .eq("email", email)
    .single();

  if (!data) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
