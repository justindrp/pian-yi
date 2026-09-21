import webpush from "web-push";
import { requiredEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The devices of everyone currently in `admin_users`, or null if the allowlist
 * could not be read.
 *
 * push_subscriptions.user_email has no FK to admin_users, so a device stays
 * registered after the person is removed from admin_users and keeps receiving
 * customer data. Agnes's two devices were still being pushed to on the day she
 * was revoked. Every send resolves through here, so deleting the admin_users
 * row is on its own enough to cut a device off.
 *
 * Null is "we do not know", never "nobody" — the callers must fail closed on
 * it rather than broadcast.
 */
async function resolveRecipients(): Promise<Recipient[] | null> {
  const db = createAdminClient();

  const { data: admins, error: adminsErr } = await db
    .from("admin_users")
    .select("email");
  if (adminsErr || !admins) {
    console.error("[push] admin lookup failed:", adminsErr);
    return null;
  }
  const allowed = new Set(
    admins.map((a) => a.email.trim().toLowerCase()).filter(Boolean),
  );
  if (!allowed.size) return [];

  const { data: allSubs, error: subsErr } = await db
    .from("push_subscriptions")
    .select("*");
  if (subsErr) {
    console.error("[push] subscription lookup failed:", subsErr);
    return null;
  }
  const subs = (allSubs ?? []).filter((s) =>
    allowed.has(s.user_email.trim().toLowerCase()),
  );

  // Remember who this resolved to, for sendOutageAlert() below — the one
  // caller that has to work when these two reads cannot.
  cacheRecipients(subs);
  return subs;
}

/**
 * Refresh the cached recipient list while the database still answers, so an
 * outage alert has somewhere to go. Called by the db-health probe on a healthy
 * tick; safe to call often, and silent when it fails.
 */
export async function warmRecipientCache(): Promise<void> {
  if (Date.now() - cachedAt < WARM_INTERVAL_MS) return;
  try {
    await resolveRecipients();
  } catch (err) {
    console.error("[push] could not warm recipient cache:", err);
  }
}

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

  // Fail closed: without the allowlist we cannot tell a current admin from a
  // revoked one, and broadcasting to everyone is the worse half of that trade.
  // A dropped notification is recoverable; a leak is not.
  const subs = await resolveRecipients();
  if (!subs) {
    console.error("[push] recipients unresolved, sending nothing");
    return;
  }
  if (!subs.length) return;

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

// ---------------------------------------------------------------------------
// Alerting during a database outage
//
// Everything above needs two reads — admin_users for the allowlist,
// push_subscriptions for the devices — so on 2026-09-21, when PostgREST wedged
// for ninety minutes, the only path that could have told anyone was down with
// the thing it would have reported. Justin found out by opening the dashboard.
//
// So the recipient list is cached in memory from the last send that worked,
// and an outage alert falls back to it. That is a deliberately narrower
// promise than sendPushToAllAdmins keeps: the list can be stale, and a
// just-revoked admin could receive one more notification from it. That is
// acceptable here and nowhere else, because an outage alert carries no
// customer data — it says the database is unreachable and nothing more. The
// fail-closed rule above is about leaking customer data to a revoked device,
// and there is none in this payload to leak.

type Recipient = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

let cachedSubs: Recipient[] = [];
let cachedAt = 0;

/** How often the db-health probe is allowed to refresh the cache. */
const WARM_INTERVAL_MS = 30 * 60 * 1000;

/** Stale beyond this and we would rather say nothing than push to a list of
 * devices that may no longer belong to anyone on the team. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheRecipients(subs: Recipient[]): void {
  cachedSubs = subs.map((s) => ({
    id: s.id,
    endpoint: s.endpoint,
    p256dh: s.p256dh,
    auth: s.auth,
  }));
  cachedAt = Date.now();
}

/**
 * Push an infrastructure alert, using the cached recipient list when the
 * database cannot be read. Carries no customer data by construction.
 *
 * Returns how many devices it reached, so the caller can log whether anyone
 * was actually told.
 */
export async function sendOutageAlert(
  title: string,
  body: string,
): Promise<number> {
  if (!cachedSubs.length || Date.now() - cachedAt > CACHE_TTL_MS) {
    console.error(
      `[push] outage alert not sent, no usable recipient cache: ${title}`,
    );
    return 0;
  }

  try {
    webpush.setVapidDetails(
      requiredEnv("VAPID_SUBJECT", process.env.VAPID_SUBJECT),
      requiredEnv("VAPID_PUBLIC_KEY", process.env.VAPID_PUBLIC_KEY),
      requiredEnv("VAPID_PRIVATE_KEY", process.env.VAPID_PRIVATE_KEY),
    );
  } catch (err) {
    console.error("[push] outage alert not sent, VAPID config missing:", err);
    return 0;
  }

  const payload = JSON.stringify({
    title,
    body,
    url: "/",
    priority: "high" as const,
  });

  const results = await Promise.all(
    cachedSubs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        );
        return 1;
      } catch {
        // No 410 cleanup here: that is a write, and the database is why we are
        // in this function. The next healthy send prunes it.
        return 0;
      }
    }),
  );
  return results.reduce<number>((a, b) => a + b, 0);
}
