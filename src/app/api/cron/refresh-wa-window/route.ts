import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isOutsideWindowError,
  sendTextMessage,
  sendTextTemplate,
} from "@/lib/whatsapp/client";
import { WINDOW_NOTICE_TEMPLATE } from "@/lib/whatsapp/window-notice";

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

    // The window can lapse between the query and the send, so a rejected
    // free-form message falls back to the approved template — the only thing
    // Meta still delivers once the 24h window is shut.
    try {
      await sendTextMessage(
        customer.phone_number,
        'Halo kak, maaf ganggu ya 🙏 Karena keterbatasan WhatsApp Business, kami tidak bisa menghubungi kakak kalau tidak ada balasan dalam 24 jam. Mohon balas "ok" supaya kami tetap bisa menghubungi kakak kalau ada info penting ya!',
      );
    } catch (err) {
      if (!isOutsideWindowError(err)) {
        console.error("[refresh-wa-window] send failed:", err);
        continue;
      }
      await sendTextTemplate(customer.phone_number, WINDOW_NOTICE_TEMPLATE, [
        customer.name ?? "kak",
      ]).catch((e) =>
        console.error("[refresh-wa-window] template fallback failed:", e),
      );
    }
    sent++;
  }

  return NextResponse.json({ ok: true, sent });
}

export const dynamic = "force-dynamic";
