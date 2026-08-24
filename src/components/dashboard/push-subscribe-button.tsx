"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

// This control has to stay visible once notifications are on. It used to
// render null when subscribed, on the assumption that a live subscription
// means working notifications — but a push service accepts messages for a
// subscription the device has quietly stopped honouring, answering 201 for
// three days while the iPhone showed nothing. There was then no way to reset it
// from the phone, which is the one device that can. Off-then-on drops the old
// subscription and registers a fresh one.
export default function PushSubscribeButton() {
  const [subscribed, setSubscribed] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState<null | "on" | "off" | "test">(null);

  useEffect(() => {
    setIsIOS(/iphone|ipad|ipod/i.test(navigator.userAgent));

    // Subscribed means: THIS browser holds a live push subscription AND the server
    // knows that exact endpoint. Either half missing → show the button again.
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (!existing) return;

      const res = await fetch(
        `/api/push/config?endpoint=${encodeURIComponent(existing.endpoint)}`,
      );
      const data = (await res.json()) as { hasSubscription?: boolean };
      if (data.hasSubscription === true) {
        setSubscribed(true);
        return;
      }

      // Browser has a subscription the DB lost — re-save it silently
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(existing.toJSON()),
      });
      setSubscribed(true);
    })().catch(() => {});
  }, []);

  function isStandalone() {
    return (
      ("standalone" in navigator &&
        (navigator as { standalone?: boolean }).standalone === true) ||
      window.matchMedia("(display-mode: standalone)").matches
    );
  }

  async function subscribe() {
    setError(null);
    setNote(null);

    if (isIOS && !isStandalone()) {
      setShowIOSGuide(true);
      return;
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setError("Push notifications not supported in this browser.");
      return;
    }

    try {
      setLoading("on");

      // Fetch the VAPID public key from the server to avoid build-time baking issues
      const configRes = await fetch("/api/push/config");
      const { vapidPublicKey } = (await configRes.json()) as {
        vapidPublicKey: string;
      };
      if (!vapidPublicKey) throw new Error("VAPID public key not configured");

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidPublicKey,
      });

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });

      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok)
        throw new Error(json.error ?? "Failed to save subscription");

      setSubscribed(true);
      setNote("Notifications on for this device.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to enable notifications",
      );
    } finally {
      setLoading(null);
    }
  }

  // Drop it on both sides. Unsubscribing in the browser without deleting the
  // row leaves the server pushing to an endpoint nothing listens to; deleting
  // the row without unsubscribing means the browser hands back the same dead
  // subscription next time and nothing is actually reset.
  async function unsubscribe() {
    setError(null);
    setNote(null);
    try {
      setLoading("off");
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        });
        await existing.unsubscribe();
      }
      setSubscribed(false);
      setNote("Notifications off. Tap Enable to register this device again.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to disable notifications",
      );
    } finally {
      setLoading(null);
    }
  }

  async function sendTest() {
    setError(null);
    setNote(null);
    try {
      setLoading("test");
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const res = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: existing?.endpoint }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        results?: { status: number; ok: boolean; error?: string }[];
      };
      if (!json.ok) {
        setError(
          json.results?.[0]?.error ?? json.error ?? "Test push failed to send",
        );
        return;
      }
      setNote(
        "Sent. Nothing on your phone within a few seconds means iOS is dropping it — turn notifications off and on again.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test push failed");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-2">
        {subscribed ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              Notifications on
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={sendTest}
              disabled={loading !== null}
            >
              {loading === "test" ? "Sending…" : "Test"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={unsubscribe}
              disabled={loading !== null}
            >
              {loading === "off" ? "Turning off…" : "Turn off"}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={subscribe}
            disabled={loading !== null}
            className="bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100"
          >
            {loading === "on" ? "Enabling…" : "Enable notifications"}
          </Button>
        )}
      </div>
      {note && <p className="mt-1 text-xs text-gray-500">{note}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {showIOSGuide && (
        <div className="absolute right-0 mt-2 w-72 p-3 bg-white border border-gray-200 rounded-xl shadow-lg text-sm text-gray-700 z-10">
          <p className="font-medium mb-1">Enable on iPhone/iPad</p>
          <p>
            Tap the Share button (square with arrow), then select{" "}
            <strong>Add to Home Screen</strong>. Open from there to enable push
            notifications.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowIOSGuide(false)}
            className="mt-2 text-gray-400"
          >
            Close
          </Button>
        </div>
      )}
    </div>
  );
}
