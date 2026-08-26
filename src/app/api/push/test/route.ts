import { type NextRequest, NextResponse } from "next/server";
import webpush from "web-push";
import { requiredEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

// A test push goes to the caller's own devices, never through
// sendPushToAllAdmins — checking whether your phone still receives anything is
// not a reason to buzz everyone else's.
export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email)
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );

  const { endpoint } = (await req.json().catch(() => ({}))) as {
    endpoint?: string;
  };

  let query = supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_email", user.email);
  if (endpoint) query = query.eq("endpoint", endpoint);

  const { data: subs } = await query;
  if (!subs?.length)
    return NextResponse.json(
      { ok: false, error: "No subscription registered for this device" },
      { status: 404 },
    );

  webpush.setVapidDetails(
    requiredEnv("VAPID_SUBJECT", process.env.VAPID_SUBJECT),
    requiredEnv("VAPID_PUBLIC_KEY", process.env.VAPID_PUBLIC_KEY),
    requiredEnv("VAPID_PRIVATE_KEY", process.env.VAPID_PRIVATE_KEY),
  );

  const payload = JSON.stringify({
    title: "Test notification",
    body: "Push notifications are working",
    url: "/dashboard",
    priority: "high",
  });

  // The status code is the whole point of this route: a push service that
  // accepts a message for a dead subscription answers 201 exactly like a live
  // one, and 410 is the only reliable signal the device is gone. Report both
  // back instead of swallowing them, which is what left the iPhone looking
  // healthy in the table for three days while showing nothing.
  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        const res = await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        );
        return { endpoint: sub.endpoint, status: res.statusCode, ok: true };
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode ?? 0;
        if (status === 410 || status === 404) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        }
        return {
          endpoint: sub.endpoint,
          status,
          ok: false,
          error:
            (err as { body?: string; message?: string }).body ??
            (err as Error).message,
        };
      }
    }),
  );

  return NextResponse.json({ ok: results.some((r) => r.ok), results });
}

export const dynamic = "force-dynamic";
