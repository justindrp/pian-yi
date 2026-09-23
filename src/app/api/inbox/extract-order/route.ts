import { type NextRequest, NextResponse } from "next/server";
import {
  extractOrderFromConversation,
  getExtractedOrderPricing,
} from "@/lib/claude/extract-order";
import { normalizeSize } from "@/lib/orders/size";
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

  // On the kitchen the extraction named, else the one the customer already
  // cooks with — the same order `createOrderFromExtraction` resolves it in. The
  // kitchens do not sell at the same rates and there is no house ladder
  // (migration 135), so with neither the modal shows Rp 0 and confirming asks
  // the customer which dapur.
  const { data: cust } = await createAdminClient()
    .from("customers")
    .select("subcontractor_id")
    .eq("id", customer_id)
    .maybeSingle();
  const kitchen = extracted.subcontractor_id ?? cust?.subcontractor_id ?? null;
  const pricing = kitchen
    ? await getExtractedOrderPricing(
        extracted.package_size,
        false,
        customer_id,
        normalizeSize(extracted.size),
        kitchen,
      )
    : { price_per_portion: 0, total_price: 0 };
  return NextResponse.json({ ok: true, data: { ...extracted, subcontractor_id: kitchen ?? undefined, ...pricing },
  });
}

export const dynamic = "force-dynamic";
