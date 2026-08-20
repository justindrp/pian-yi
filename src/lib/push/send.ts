import webpush from "web-push";
import { requiredEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export async function sendPushToAllAdmins(
  title: string,
  body: string,
  url: string,
  priority: "high" | "medium" | "low",
): Promise<void> {
  webpush.setVapidDetails(
    requiredEnv("VAPID_SUBJECT", process.env.VAPID_SUBJECT),
    requiredEnv("VAPID_PUBLIC_KEY", process.env.VAPID_PUBLIC_KEY),
    requiredEnv("VAPID_PRIVATE_KEY", process.env.VAPID_PRIVATE_KEY),
  );
  const db = createAdminClient();

  // push_subscriptions.user_email has no FK to admin_users, so a device stays
  // registered after the person is removed from admin_users and keeps receiving
  // customer data. Agnes's two devices were still being pushed to on the day she
  // was revoked. Filter every send against the current admin list, so deleting
  // the admin_users row is on its own enough to cut a device off.
  const { data: admins, error: adminsErr } = await db
    .from("admin_users")
    .select("email");
  if (adminsErr || !admins) {
    // Fail closed and loudly: without the allowlist we cannot tell a current
    // admin from a revoked one, and broadcasting to everyone is the worse half
    // of that trade. A dropped notification is recoverable; a leak is not.
    console.error("[push] admin lookup failed, sending nothing:", adminsErr);
    return;
  }
  const allowed = new Set(
    admins.map((a) => a.email.trim().toLowerCase()).filter(Boolean),
  );
  if (!allowed.size) return;

  const { data: allSubs } = await db.from("push_subscriptions").select("*");
  const subs = allSubs?.filter((s) =>
    allowed.has(s.user_email.trim().toLowerCase()),
  );
  if (!subs?.length) return;

  const payload = JSON.stringify({ title, body, url, priority });
  const expired: string[] = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        );
        await db
          .from("push_subscriptions")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", sub.id);
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 410 || statusCode === 404) {
          expired.push(sub.id);
        }
      }
    }),
  );

  if (expired.length) {
    await db.from("push_subscriptions").delete().in("id", expired);
  }
}
