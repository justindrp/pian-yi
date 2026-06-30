import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendTextMessage } from "@/lib/whatsapp/client";

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

  const body = (await req.json()) as { customer_id: string; text: string };
  const { customer_id, text } = body;

  if (!customer_id || !text?.trim()) {
    return NextResponse.json(
      { ok: false, error: "customer_id and text required" },
      { status: 400 },
    );
  }

  const db = createAdminClient();

  const { data: customer, error: custErr } = await db
    .from("customers")
    .select("phone_number")
    .eq("id", customer_id)
    .single();

  if (custErr || !customer) {
    return NextResponse.json(
      { ok: false, error: "Customer not found" },
      { status: 404 },
    );
  }

  const { data: row, error: insertErr } = await db
    .from("conversations")
    .insert({
      customer_id,
      role: "assistant",
      content: text.trim(),
      model_used: "human",
      message_type: "text",
    })
    .select()
    .single();

  if (insertErr) {
    return NextResponse.json(
      { ok: false, error: insertErr.message },
      { status: 500 },
    );
  }

  const messageId = await sendTextMessage(customer.phone_number, text.trim());

  const { data: updatedRow } = await db
    .from("conversations")
    .update({
      message_id: messageId,
      whatsapp_status: "sent",
      whatsapp_status_updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .select()
    .single();

  await db
    .from("customer_flags")
    .update({
      last_human_activity_at: new Date().toISOString(),
      pending_bot_response: false,
      pending_bot_question: null,
    })
    .eq("customer_id", customer_id);

  return NextResponse.json({ ok: true, row: updatedRow ?? row });
}

export const dynamic = "force-dynamic";
