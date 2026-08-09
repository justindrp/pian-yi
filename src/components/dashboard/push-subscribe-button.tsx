"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export default function PushSubscribeButton() {
  const [subscribed, setSubscribed] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    setIsIOS(ios);

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

    if (isIOS && !isStandalone()) {
      setShowIOSGuide(true);
      return;
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setError("Push notifications not supported in this browser.");
      return;
    }

    try {
      setLoading(true);

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
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to enable notifications",
      );
    } finally {
      setLoading(false);
    }
  }

  if (subscribed) return null;

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={subscribe}
        disabled={loading}
        className="bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100"
      >
        {loading ? "Enabling…" : "Enable notifications"}
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {showIOSGuide && (
        <div className="absolute right-6 mt-2 w-72 p-3 bg-white border border-gray-200 rounded-xl shadow-lg text-sm text-gray-700 z-10">
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
