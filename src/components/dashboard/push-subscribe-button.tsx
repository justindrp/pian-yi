"use client";

import { useEffect, useState } from "react";

export default function PushSubscribeButton() {
  const [subscribed, setSubscribed] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    setIsIOS(ios);

    // Use server as source of truth — browser may have a subscription the DB doesn't know about
    fetch("/api/push/config")
      .then((r) => r.json())
      .then((data: { hasSubscription?: boolean }) => {
        setSubscribed(data.hasSubscription === true);
      })
      .catch(() => {});
  }, []);

  function isStandalone() {
    return (
      ("standalone" in navigator && (navigator as { standalone?: boolean }).standalone === true) ||
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
      const { vapidPublicKey } = await configRes.json() as { vapidPublicKey: string };
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

      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Failed to save subscription");

      setSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enable notifications");
    } finally {
      setLoading(false);
    }
  }

  if (subscribed) return null;

  return (
    <div>
      <button
        type="button"
        onClick={subscribe}
        disabled={loading}
        className="text-sm px-3 py-1.5 bg-orange-50 text-orange-700 border border-orange-200 rounded-lg hover:bg-orange-100 transition-colors disabled:opacity-50"
      >
        {loading ? "Enabling…" : "Enable notifications"}
      </button>
      {error && (
        <p className="mt-1 text-xs text-red-600">{error}</p>
      )}
      {showIOSGuide && (
        <div className="absolute right-6 mt-2 w-72 p-3 bg-white border border-gray-200 rounded-xl shadow-lg text-sm text-gray-700 z-10">
          <p className="font-medium mb-1">Enable on iPhone/iPad</p>
          <p>
            Tap the Share button (square with arrow), then select{" "}
            <strong>Add to Home Screen</strong>. Open from there to enable push
            notifications.
          </p>
          <button
            type="button"
            onClick={() => setShowIOSGuide(false)}
            className="mt-2 text-xs text-gray-400 hover:text-gray-600"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
