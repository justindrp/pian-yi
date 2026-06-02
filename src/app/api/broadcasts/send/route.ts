import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sendTextMessage } from "@/lib/whatsapp/client";

interface RecipientInput {
  customer_id: string;
  phone_number: string;
  personalized_message: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    instruction: string;
    message_template: string;
    filter: Record<string, unknown>;
    recipients: RecipientInput[];
  };

  const { instruction, message_template, filter, recipients } = body;
  if (!recipients?.length) return NextResponse.json({ ok: false, error: "No recipients" }, { status: 400 });

  const db = createAdminClient();

  // Create broadcast record
  const { data: broadcast, error: broadcastError } = await db
    .from("broadcasts")
    .insert({
      created_by: user.email ?? "",
      instruction,
      message_template,
      filter: filter as import("@/types/database").Json,
      recipient_count: recipients.length,
      status: "sent",
    })
    .select("id")
    .single();

  if (broadcastError || !broadcast) {
    return NextResponse.json({ ok: false, error: "Failed to create broadcast" }, { status: 500 });
  }

  // Send messages and record results
  const results: {
    broadcast_id: string;
    customer_id: string;
    phone_number: string;
    personalized_message: string;
    status: "sent" | "failed";
    error: string | null;
    sent_at: string | null;
  }[] = [];

  for (const r of recipients) {
    try {
      await sendTextMessage(r.phone_number, r.personalized_message);
      results.push({
        broadcast_id: broadcast.id,
        customer_id: r.customer_id,
        phone_number: r.phone_number,
        personalized_message: r.personalized_message,
        status: "sent",
        error: null,
        sent_at: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({
        broadcast_id: broadcast.id,
        customer_id: r.customer_id,
        phone_number: r.phone_number,
        personalized_message: r.personalized_message,
        status: "failed",
        error: message,
        sent_at: null,
      });
    }
  }

  await db.from("broadcast_recipients").insert(results);

  const sentCount = results.filter((r) => r.status === "sent").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  // Update status to failed if all failed
  if (sentCount === 0) {
    await db.from("broadcasts").update({ status: "failed" }).eq("id", broadcast.id);
  }

  await db.from("edit_log").insert({
    entity_type: "broadcasts",
    entity_id: broadcast.id,
    action: "send",
    changed_by: user.email ?? "",
    changes: { sent: sentCount, failed: failedCount },
  });

  return NextResponse.json({ ok: true, data: { broadcast_id: broadcast.id, sent: sentCount, failed: failedCount } });
}

export const dynamic = "force-dynamic";
