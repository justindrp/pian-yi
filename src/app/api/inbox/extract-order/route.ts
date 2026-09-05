import { type NextRequest, NextResponse } from "next/server";
import {
  extractOrderFromConversation,
  getExtractedOrderPricing,
} from "@/lib/claude/extract-order";
import { normalizeSize } from "@/lib/orders/size";
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
      {
        ok: false,
        error: "Could not extract order details from this conversation",
      },
      { status: 422 },
    );
  }

  // On the kitchen the extraction named, not the house ladder: the review modal
  // shows this figure to an admin as the price of the order, and the kitchens do
  // not sell at the same rates.
  const pricing = await getExtractedOrderPricing(
    extracted.package_size,
    false,
    customer_id,
    normalizeSize(extracted.size),
    extracted.subcontractor_id ?? null,
  );
  return NextResponse.json({ ok: true, data: { ...extracted, ...pricing } });
}

export const dynamic = "force-dynamic";
