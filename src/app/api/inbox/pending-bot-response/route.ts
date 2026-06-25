import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { customer_id: string; question?: string };
  const { customer_id, question } = body;

  if (!customer_id) {
    return NextResponse.json({ ok: false, error: "Missing customer_id" }, { status: 400 });
  }

  const db = createAdminClient();
  const { error } = await db
    .from("customer_flags")
    .upsert({
      customer_id,
      pending_bot_response: true,
      pending_bot_question: question ?? null,
    });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
