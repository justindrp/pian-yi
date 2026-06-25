import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendImageMessageById, uploadMediaToMeta } from "@/lib/whatsapp/client";

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const customerId = form.get("customer_id");
  const file = form.get("file");
  const caption = (form.get("caption") as string | null)?.trim() ?? "";

  if (!customerId || typeof customerId !== "string") {
    return NextResponse.json({ ok: false, error: "customer_id required" }, { status: 400 });
  }
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "file required" }, { status: 400 });
  }

  const db = createAdminClient();

  const { data: customer, error: custErr } = await db
    .from("customers")
    .select("phone_number")
    .eq("id", customerId)
    .single();

  if (custErr || !customer) {
    return NextResponse.json({ ok: false, error: "Customer not found" }, { status: 404 });
  }

  const ext = file.name.split(".").pop() ?? "jpg";
  const storagePath = `inbox/${customerId}/${Date.now()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  // Upload to Supabase for conversation history display
  const { error: uploadErr } = await db.storage
    .from("menu-images")
    .upload(storagePath, buffer, { contentType: file.type, upsert: false });

  if (uploadErr) {
    return NextResponse.json({ ok: false, error: uploadErr.message }, { status: 500 });
  }

  const {
    data: { publicUrl },
  } = db.storage.from("menu-images").getPublicUrl(storagePath);

  // Upload to Meta's media endpoint so they serve from their own CDN (link-based sending fails silently)
  const mediaId = await uploadMediaToMeta(buffer, file.type || "image/jpeg");
  await sendImageMessageById(customer.phone_number, mediaId, caption);

  const { data: row, error: insertErr } = await db
    .from("conversations")
    .insert({
      customer_id: customerId,
      role: "assistant",
      content: publicUrl,
      message_type: "image",
      model_used: "human",
    })
    .select()
    .single();

  if (insertErr) {
    return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });
  }

  await db
    .from("customer_flags")
    .update({ last_human_activity_at: new Date().toISOString() })
    .eq("customer_id", customerId);

  return NextResponse.json({ ok: true, row });
}

export const dynamic = "force-dynamic";
