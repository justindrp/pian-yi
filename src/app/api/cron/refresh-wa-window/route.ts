import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
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
  const now = new Date();
  const twelveHoursAgo = new Date(now.getTime() - 12 * 3600000).toISOString();
  const twentyThreeHoursAgo = new Date(
    now.getTime() - 23 * 3600000,
  ).toISOString();

  // Customers whose last inbound message was 12–23h ago: window still open but
  // will expire before the next 12h cron run.
  const { data: rows, error } = await db
    .from("customer_rate_limits")
    .select(
      "customer_id, last_message_at, customers!customer_rate_limits_customer_id_fkey(phone_number, name)",
    )
    .gte("last_message_at", twentyThreeHoursAgo)
    .lte("last_message_at", twelveHoursAgo);

  if (error) {
    console.error("[refresh-wa-window] query error:", error);
    return NextResponse.json({ ok: false, error: error.message });
  }

  let sent = 0;
  for (const row of rows ?? []) {
    const customer = row.customers as {
      phone_number: string;
      name: string | null;
    } | null;
    if (!customer?.phone_number) continue;

    await sendTextMessage(
      customer.phone_number,
      "halo kak, ada yang bisa kami bantu? balas pesan ini ya 😊",
    );
    sent++;
  }

  return NextResponse.json({ ok: true, sent });
}

export const dynamic = "force-dynamic";
