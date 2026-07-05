import { type NextRequest, NextResponse } from "next/server";
import {
  createOrderFromExtraction,
  type ExtractedOrderInput,
} from "@/lib/claude/extract-order";
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

  const body = (await req.json()) as {
    customer_id: string;
    input: ExtractedOrderInput;
    send_payment_info?: boolean;
  };
  const { customer_id, input, send_payment_info } = body;
  if (!customer_id || !input) {
    return NextResponse.json(
      { ok: false, error: "customer_id and input required" },
      { status: 400 },
    );
  }

  const db = createAdminClient();
  const { data: customer, error } = await db
    .from("customers")
    .select("phone_number")
    .eq("id", customer_id)
    .single();
  if (error || !customer) {
    return NextResponse.json(
      { ok: false, error: "Customer not found" },
      { status: 404 },
    );
  }

  await createOrderFromExtraction(customer_id, customer.phone_number, input, {
    sendPaymentInfo: send_payment_info ?? true,
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
