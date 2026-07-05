import { type NextRequest, NextResponse } from "next/server";
import {
  CUSTOMER_STATES,
  type CustomerStateValue,
  normalizeCustomerState,
} from "@/lib/customers/lifecycle";
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
    customer_id?: string;
    stage?: CustomerStateValue | "browsing";
  };
  const { customer_id, stage } = body;
  const validStages = new Set<string>([...CUSTOMER_STATES, "browsing"]);
  const normalizedStage = normalizeCustomerState(stage);

  if (!customer_id || !stage || !validStages.has(stage)) {
    return NextResponse.json(
      { ok: false, error: "customer_id and valid stage required" },
      { status: 400 },
    );
  }

  const db = createAdminClient();
  const now = new Date().toISOString();

  const { data: customer, error: customerErr } = await db
    .from("customers")
    .select("id")
    .eq("id", customer_id)
    .single();

  if (customerErr || !customer) {
    return NextResponse.json(
      { ok: false, error: "Customer not found" },
      { status: 404 },
    );
  }

  const stateUpdate: Record<string, string | null> = {
    state: normalizedStage,
    updated_at: now,
  };

  const { error } = await db
    .from("customer_state")
    .upsert({ customer_id, ...stateUpdate }, { onConflict: "customer_id" });
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, stage: normalizedStage });
}

export const dynamic = "force-dynamic";
