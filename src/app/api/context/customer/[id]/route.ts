import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const db = createAdminClient();

  const { data, error } = await db
    .from("customers")
    .select(
      "id, name, phone_number, notes, meal_time_preference, custom_schedule, ad_creative, promo_used, converted_at, customer_state(state), customer_flags(escalated_to_human, pending_bot_response, is_blacklisted, vip_status, is_suspicious)",
    )
    .eq("id", id)
    .single();

  if (error)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const row = data as typeof data & {
    customer_state: { state: string }[] | { state: string } | null;
    customer_flags: {
      escalated_to_human: boolean;
      pending_bot_response: boolean;
      is_blacklisted: boolean;
      vip_status: boolean;
      is_suspicious: boolean;
    }[] | {
      escalated_to_human: boolean;
      pending_bot_response: boolean;
      is_blacklisted: boolean;
      vip_status: boolean;
      is_suspicious: boolean;
    } | null;
  };

  return NextResponse.json({
    ok: true,
    data: {
      ...row,
      customer_state: Array.isArray(row.customer_state)
        ? (row.customer_state[0] ?? null)
        : row.customer_state,
      customer_flags: Array.isArray(row.customer_flags)
        ? (row.customer_flags[0] ?? null)
        : row.customer_flags,
    },
  });
}
