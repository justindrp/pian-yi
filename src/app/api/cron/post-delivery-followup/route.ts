import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAnthropicClient, HAIKU_MODEL } from "@/lib/claude/client";
import { saveMessage, updateMessageReceipt } from "@/lib/claude/conversation";
import { sendPushToAllAdmins } from "@/lib/push/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

export async function GET(req: NextRequest): Promise<Response> {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const db = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);

  // Find delivered customers today without followup
  const { data: deliveries } = await db
    .from("daily_deliveries")
    .select("customer_id, order_id, customers(phone_number, name)")
    .eq("delivery_date", today)
    .in("status", ["delivered_on_time", "delivered_late"]);

  if (!deliveries) return NextResponse.json({ ok: true, sent: 0 });

  // Deduplicate by customer_id (one followup per customer)
  const seen = new Set<string>();
  const toFollow: typeof deliveries = [];
  for (const d of deliveries) {
    if (d.customer_id && !seen.has(d.customer_id)) {
      seen.add(d.customer_id);
      toFollow.push(d);
    }
  }

  let sent = 0;
  for (const delivery of toFollow) {
    if (!delivery.customer_id || !delivery.order_id) continue;
    const customer = delivery.customers as {
      phone_number: string;
      name: string | null;
    } | null;
    if (!customer) continue;

    // Check followup not already sent on this order
    const { data: order } = await db
      .from("orders")
      .select("followup_sent_at")
      .eq("id", delivery.order_id)
      .single();
    if (order?.followup_sent_at) continue;

    // 20% sample rate (always for first delivery: check if this is first active order)
    const isFirst =
      (
        await db
          .from("orders")
          .select("id")
          .eq("customer_id", delivery.customer_id)
          .eq("status", "active")
          .limit(2)
      ).data?.length === 1;

    if (!isFirst && Math.random() >= 0.2) continue;

    const followupText = "halo kak gimana makanannya hari ini? 🍱";
    const conversationId = await saveMessage({
      customerId: delivery.customer_id,
      role: "assistant",
      content: followupText,
      messageType: "text",
    });
    const messageId = await sendTextMessage(
      customer.phone_number,
      followupText,
    );
    await updateMessageReceipt({
      conversationId,
      whatsappMessageId: messageId,
      status: "sent",
    });
    await db
      .from("orders")
      .update({ followup_sent_at: new Date().toISOString() })
      .eq("id", delivery.order_id);
    sent++;
  }

  return NextResponse.json({ ok: true, sent });
}

// Handle customer reply to followup — classify sentiment
export async function POST(req: NextRequest): Promise<Response> {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const body = (await req.json()) as {
    customer_id: string;
    delivery_id: string;
    message: string;
    phone: string;
    customer_name: string | null;
  };

  const db = createAdminClient();
  const client = getAnthropicClient();

  const res = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: `Classify this customer feedback as "positive", "neutral", or "negative". Reply with the single word only.\n\nFeedback: "${body.message}"`,
      },
    ],
  });
  const sentiment = (
    res.content[0].type === "text"
      ? res.content[0].text.trim().toLowerCase()
      : "neutral"
  ) as "positive" | "neutral" | "negative";

  await db
    .from("daily_deliveries")
    .update({
      feedback_sentiment: sentiment,
      feedback_message: body.message,
    })
    .eq("id", body.delivery_id);

  if (sentiment === "positive") {
    await sendTextMessage(
      body.phone,
      "Senang kak suka! 😊 Kalau berkenan, boleh share ke teman-teman ya 🙏",
    );
  } else if (sentiment === "neutral") {
    await sendTextMessage(body.phone, "Terima kasih feedbacknya kak 😊");
  } else {
    await db
      .from("customer_flags")
      .update({
        escalated_to_human: true,
        escalation_reason: "Negative feedback",
      })
      .eq("customer_id", body.customer_id);
    await sendPushToAllAdmins(
      `Customer ${body.customer_name ?? body.phone} gave negative feedback`,
      body.message.slice(0, 100),
      "/inbox",
      "high",
    );
  }

  return NextResponse.json({ ok: true, sentiment });
}

export const dynamic = "force-dynamic";
