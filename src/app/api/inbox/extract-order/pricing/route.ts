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

  const body = (await req.json()) as { package_size?: number };
  const packageSize = Number(body.package_size);
  if (!Number.isFinite(packageSize) || packageSize <= 0) {
    return NextResponse.json(
      { ok: false, error: "package_size must be a positive number" },
      { status: 400 },
    );
  }

  const pricing = await getExtractedOrderPricing(packageSize);
  return NextResponse.json({ ok: true, data: pricing });
}

export const dynamic = "force-dynamic";
