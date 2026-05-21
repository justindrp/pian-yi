import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSetting, getTemplate } from "@/lib/cache/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "@/lib/whatsapp/client";

export async function GET(req: NextRequest): Promise<Response> {
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const [firstWarningRaw, finalWarningRaw] = await Promise.all([
    getSetting("low_quota_first_warning"),
    getSetting("low_quota_final_warning"),
  ]);
  const firstThreshold = Number.parseInt(firstWarningRaw) || 3;
  const finalThreshold = Number.parseInt(finalWarningRaw) || 1;

  const [firstTemplate, finalTemplate] = await Promise.all([
    getTemplate("quota_low_first"),
    getTemplate("quota_low_final"),
  ]);

  // First reminder
  const { data: firstOrders } = await db
    .from("orders")
    .select("id, customer_id, customers(phone_number, name)")
    .eq("status", "active")
    .eq("portions_remaining", firstThreshold)
    .is("reminder_sent_at", null);

  for (const order of firstOrders ?? []) {
    const customer = order.customers as { phone_number: string; name: string | null } | null;
    if (!customer) continue;
    const msg = firstTemplate.replace("{name}", customer.name ?? "kak").replace("{remaining}", String(firstThreshold));
    await sendTextMessage(customer.phone_number, msg);
    await db.from("orders").update({ reminder_sent_at: new Date().toISOString() }).eq("id", order.id);
  }

  // Final reminder — portions_remaining equals final threshold AND reminder was already sent (for first) but not followup
  const { data: finalOrders } = await db
    .from("orders")
    .select("id, customer_id, customers(phone_number, name)")
    .eq("status", "active")
    .eq("portions_remaining", finalThreshold)
    .not("reminder_sent_at", "is", null)
    .is("followup_sent_at", null);

  for (const order of finalOrders ?? []) {
    const customer = order.customers as { phone_number: string; name: string | null } | null;
    if (!customer) continue;
    const msg = finalTemplate.replace("{name}", customer.name ?? "kak").replace("{remaining}", String(finalThreshold));
    await sendTextMessage(customer.phone_number, msg);
    await db.from("orders").update({ followup_sent_at: new Date().toISOString() }).eq("id", order.id);
  }

  return NextResponse.json({
    ok: true,
    firstReminders: firstOrders?.length ?? 0,
    finalReminders: finalOrders?.length ?? 0,
  });
}

export const dynamic = "force-dynamic";
