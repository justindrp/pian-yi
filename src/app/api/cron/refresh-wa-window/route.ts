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
  //
  // Read off `conversations`, which is what `hoursSinceInbound()` and every
  // other window decision reads. This used to read
  // `customer_rate_limits.last_message_at`, which is not an inbound clock: it
  // is a counter `checkRateLimit()` stamps, and that function returns early —
  // without stamping — on the first message of each day, on a VIP, and on any
  // customer over a limit, and it is only reached on the model path at all. So
  // a customer whose whole day is one "ok" never updated it. Clairine Aurelia's
  // read 2026-09-01 18:17 while she had messaged on the 2nd and the 3rd; she
  // was outside the 23h band on the 2026-09-03 08:00 run, got no nudge, her
  // window lapsed, and that evening's delivery photo failed on 131042.
  const { data: band, error } = await db
    .from("conversations")
    .select("customer_id")
    .eq("role", "user")
    .gte("created_at", twentyThreeHoursAgo)
    .lte("created_at", twelveHoursAgo)
    .limit(5000);

  if (error) {
    console.error("[refresh-wa-window] query error:", error);
    return NextResponse.json({ ok: false, error: error.message });
  }

  // Anyone who has written since the band ended has a window that outlives the
  // next run, so the nudge is neither needed nor wanted.
  const { data: newer } = await db
    .from("conversations")
    .select("customer_id")
    .eq("role", "user")
    .gt("created_at", twelveHoursAgo)
    .limit(5000);

  const spokeSince = new Set((newer ?? []).map((r) => r.customer_id));
  const ids = [
    ...new Set((band ?? []).map((r) => r.customer_id as string)),
  ].filter((id) => !spokeSince.has(id));

  const { data: rows } = ids.length
    ? await db.from("customers").select("id, phone_number, name").in("id", ids)
    : { data: [] };

  let sent = 0;
  for (const customer of rows ?? []) {
    if (!customer.phone_number) continue;

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
