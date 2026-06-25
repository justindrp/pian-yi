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

  const body = (await req.json()) as { customer_id: string; escalated: boolean };
  const { customer_id, escalated } = body;

  if (!customer_id || typeof escalated !== "boolean") {
    return NextResponse.json({ ok: false, error: "Missing customer_id or escalated" }, { status: 400 });
  }

  const db = createAdminClient();
  const { error } = await db
    .from("customer_flags")
    .upsert({
      customer_id,
      escalated_to_human: escalated,
      escalation_reason: escalated ? "Manual takeover" : null,
      last_human_activity_at: escalated ? new Date().toISOString() : null,
    });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
