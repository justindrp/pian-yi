import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionWithRole, isOwner } from "@/lib/supabase/get-role";
import {
  sendDocumentMessageById,
  uploadMediaToMeta,
} from "@/lib/whatsapp/client";

// Meta caps document uploads at 100MB
const MAX_BYTES = 100 * 1024 * 1024;

function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "document.pdf";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await getSessionWithRole();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  // Hand-typed customer messages are owner-only. Admins reach customers through
  // the Assistant instead, which records what was sent and keeps the bot in the
  // loop. See POST /api/inbox/takeover for the incident behind the rule.
  if (!isOwner(session.role)) {
    return NextResponse.json(
      { ok: false, error: "Only owners can message a customer directly" },
      { status: 403 },
    );
  }

  const form = await req.formData();
  const customerId = form.get("customer_id");
  const file = form.get("file");
  const caption = (form.get("caption") as string | null)?.trim() ?? "";

  if (!customerId || typeof customerId !== "string") {
    return NextResponse.json(
      { ok: false, error: "customer_id required" },
      { status: 400 },
    );
  }
  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "file required" },
      { status: 400 },
    );
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json(
      { ok: false, error: "File must be a PDF" },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "PDF must be 100MB or smaller" },
      { status: 400 },
    );
  }

  const db = createAdminClient();

  const { data: customer, error: custErr } = await db
    .from("customers")
    .select("phone_number")
    .eq("id", customerId)
    .single();

  if (custErr || !customer) {
    return NextResponse.json(
      { ok: false, error: "Customer not found" },
      { status: 404 },
    );
  }

  const filename = safeFilename(file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  const storagePath = `inbox/${customerId}/${Date.now()}-${filename}`;

  // Upload to Supabase for conversation history display
  const { error: uploadErr } = await db.storage
    .from("menu-images")
    .upload(storagePath, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (uploadErr) {
    return NextResponse.json(
      { ok: false, error: uploadErr.message },
      { status: 500 },
    );
  }

  const {
    data: { publicUrl },
  } = db.storage.from("menu-images").getPublicUrl(storagePath);

  // Upload to Meta's media endpoint so they serve from their own CDN (link-based sending fails silently)
  let messageId: string;
  try {
    const mediaId = await uploadMediaToMeta(
      buffer,
      "application/pdf",
      filename,
    );
    messageId = await sendDocumentMessageById(
      customer.phone_number,
      mediaId,
      filename,
      caption,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "WhatsApp send failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }

  const { data: row, error: insertErr } = await db
    .from("conversations")
    .insert({
      customer_id: customerId,
      role: "assistant",
      content: publicUrl,
      message_id: messageId,
      message_type: "document",
      model_used: "human",
      whatsapp_status: "sent",
      whatsapp_status_updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertErr) {
    return NextResponse.json(
      { ok: false, error: insertErr.message },
      { status: 500 },
    );
  }

  await db
    .from("customer_flags")
    .update({
      last_human_activity_at: new Date().toISOString(),
      pending_bot_response: false,
      pending_bot_question: null,
    })
    .eq("customer_id", customerId);

  return NextResponse.json({ ok: true, row });
}

export const dynamic = "force-dynamic";
