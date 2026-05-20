"use client";

import { useEffect, useState } from "react";

export default function PushSubscribeButton() {
  const [subscribed, setSubscribed] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  useEffect(() => {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    setIsIOS(ios);

    if ("serviceWorker" in navigator && "PushManager" in window) {
      navigator.serviceWorker.ready.then(async (reg) => {
        const sub = await reg.pushManager.getSubscription();
        setSubscribed(!!sub);
      });
    }
  }, []);

  async function subscribe() {
    if (isIOS) {
      setShowIOSGuide(true);
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    });

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });

    setSubscribed(true);
  }

  if (subscribed) return null;

  return (
    <div>
      <button
        type="button"
        onClick={subscribe}
        className="text-sm px-3 py-1.5 bg-orange-50 text-orange-700 border border-orange-200 rounded-lg hover:bg-orange-100 transition-colors"
      >
        Enable notifications
      </button>
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
