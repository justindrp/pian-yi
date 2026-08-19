import { type NextRequest, NextResponse } from "next/server";
import { getExtractedOrderPricing } from "@/lib/claude/extract-order";
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

  const body = (await req.json()) as {
    package_size?: number;
    customer_id?: string;
  };
  const packageSize = Number(body.package_size);
  if (!Number.isFinite(packageSize) || packageSize <= 0) {
    return NextResponse.json(
      { ok: false, error: "package_size must be a positive number" },
      { status: 400 },
    );
  }

  // customer_id is optional: the review modal reprices as the admin edits the
  // size, and a corporate customer must reprice at their contract rate.
  const pricing = await getExtractedOrderPricing(
    packageSize,
    false,
    body.customer_id ?? null,
  );
  return NextResponse.json({ ok: true, data: pricing });
}

export const dynamic = "force-dynamic";
