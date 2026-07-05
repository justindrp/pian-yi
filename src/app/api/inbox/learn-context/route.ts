import { type NextRequest, NextResponse } from "next/server";
import { learnCustomerContext } from "@/lib/claude/learn-context";
import { createAdminClient } from "@/lib/supabase/admin";
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

  const body = (await req.json()) as { customer_id?: string };
  const customerId = body.customer_id;
  if (!customerId) {
    return NextResponse.json(
      { ok: false, error: "customer_id required" },
      { status: 400 },
    );
  }

  try {
    const { summary } = await learnCustomerContext(
      customerId,
      createAdminClient(),
    );
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    const error =
      err instanceof Error ? err.message : "Could not learn context";
    const status =
      error === "Customer not found"
        ? 404
        : error === "No conversation to learn" ||
            error === "Not enough customer messages to learn"
          ? 400
          : 500;
    return NextResponse.json({ ok: false, error }, { status });
  }
}

export const dynamic = "force-dynamic";
