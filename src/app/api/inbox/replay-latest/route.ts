import { type NextRequest, NextResponse } from "next/server";
import { processSavedCustomerMessage } from "@/app/api/webhook/whatsapp/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { customer_id: string };
  const { customer_id } = body;

  if (!customer_id) {
    return NextResponse.json({ ok: false, error: "customer_id required" }, { status: 400 });
  }

  const db = createAdminClient();

  const [{ data: customer, error: customerError }, { data: flags, error: flagError }, { data: stateRow }, { data: latestMessage, error: latestError }] =
    await Promise.all([
      db.from("customers").select("id, name, phone_number, notes").eq("id", customer_id).single(),
      db
        .from("customer_flags")
        .select("escalated_to_human, pending_bot_response, is_blacklisted")
        .eq("customer_id", customer_id)
        .single(),
      db.from("customer_state").select("state, menu_shown").eq("customer_id", customer_id).single(),
      db
        .from("conversations")
        .select("role, content, message_id, message_type")
        .eq("customer_id", customer_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single(),
    ]);

  if (customerError || !customer) {
    return NextResponse.json({ ok: false, error: "Customer not found" }, { status: 404 });
  }
  if (flagError || !flags) {
    return NextResponse.json({ ok: false, error: "Customer flags not found" }, { status: 404 });
  }
  if (latestError || !latestMessage) {
    return NextResponse.json({ ok: false, error: "No messages found" }, { status: 404 });
  }
  if (flags.is_blacklisted) {
    return NextResponse.json({ ok: true, replayed: false, reason: "blacklisted" });
  }
  if (flags.escalated_to_human || flags.pending_bot_response) {
    return NextResponse.json({ ok: true, replayed: false, reason: "thread_blocked" });
  }
  if (!(stateRow?.menu_shown ?? false)) {
    return NextResponse.json({ ok: true, replayed: false, reason: "welcome_flow_only" });
  }
  if (latestMessage.role !== "user") {
    return NextResponse.json({ ok: true, replayed: false, reason: "latest_not_user" });
  }
  if ((latestMessage.message_type ?? "text") !== "text") {
    return NextResponse.json({ ok: true, replayed: false, reason: "latest_not_text" });
  }
  if (!latestMessage.content?.trim()) {
    return NextResponse.json({ ok: true, replayed: false, reason: "empty_message" });
  }

  await processSavedCustomerMessage({
    customerId: customer.id,
    customerName: customer.name,
    customerNotes: customer.notes,
    phone: customer.phone_number,
    stateRow,
    text: latestMessage.content,
    messageId: null,
  });

  return NextResponse.json({ ok: true, replayed: true });
}

export const dynamic = "force-dynamic";
