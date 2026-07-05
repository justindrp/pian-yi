import { type NextRequest, NextResponse } from "next/server";
import { extractOrderFromConversation } from "@/lib/claude/extract-order";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const body = (await req.json()) as { customer_id: string };
  const { customer_id } = body;
  if (!customer_id) {
    return NextResponse.json(
      { ok: false, error: "customer_id required" },
      { status: 400 },
    );
  }

  const extracted = await extractOrderFromConversation(customer_id);
  if (!extracted) {
    return NextResponse.json(
      { ok: false, error: "Could not extract order details from this conversation" },
      { status: 422 },
    );
  }

  return NextResponse.json({ ok: true, data: extracted });
}

export const dynamic = "force-dynamic";
