import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";

export async function sendPushToAllAdmins(
  title: string,
  body: string,
  url: string,
  priority: "high" | "medium" | "low",
): Promise<void> {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT!,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  const db = createAdminClient();
  const { data: subs } = await db.from("push_subscriptions").select("*");
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
