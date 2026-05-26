import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { saveMessage } from "@/lib/claude/conversation";
import { sendTextMessage } from "@/lib/whatsapp/client";

export async function GET(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");

  const db = createAdminClient();
  let query = db
    .from("orders")
    .select("*, customers(name, phone_number)")
    .order("created_at", { ascending: false })
    .limit(100);

  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data });
}


export async function PATCH(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { id: string; action: "mark_paid" };
  if (!body.id || body.action !== "mark_paid")
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });

  const db = createAdminClient();

  // Fetch order + customer in one query
  const { data: order, error: fetchErr } = await db
    .from("orders")
    .select("id, customer_id, customers(name, phone_number)")
    .eq("id", body.id)
    .single();
  if (fetchErr || !order)
    return NextResponse.json({ ok: false, error: "Order not found" }, { status: 404 });

  // Update order status
  const { error: updateErr } = await db
    .from("orders")
    .update({ status: "active", paid_at: new Date().toISOString() })
    .eq("id", body.id);
  if (updateErr)
    return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });

  // Send WhatsApp confirmation
  const rawCustomer = order.customers;
  const customer = (Array.isArray(rawCustomer) ? rawCustomer[0] : rawCustomer) as {
    name: string | null;
    phone_number: string;
  } | null;
  console.log("[mark_paid] customer:", JSON.stringify(customer), "customer_id:", order.customer_id);
  if (customer?.phone_number && order.customer_id) {
    const firstName = (customer.name ?? "").split(" ")[0] || "kak";
    const msg = `Halo kak ${firstName}! Pembayaran kamu sudah kami verifikasi dan pesananmu sekarang sudah aktif. Terima kasih ya kak, selamat menikmati! 🎉`;
    try {
      await saveMessage({ customerId: order.customer_id, role: "assistant", content: msg });
      await sendTextMessage(customer.phone_number, msg);
      console.log("[mark_paid] WhatsApp sent to", customer.phone_number);
    } catch (err) {
      console.error("[mark_paid] WhatsApp send failed:", err);
    }
  }

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
