"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export default function KillSwitch({
  initialEnabled,
}: {
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  async function toggle() {
    if (enabled) {
      setShowConfirm(true);
      return;
    }
    await applyToggle(true);
  }

  async function applyToggle(newValue: boolean) {
    setLoading(true);
    setShowConfirm(false);
    // Through the settings API rather than the browser client: it records who
    // flipped the switch in edit_log, and it invalidates the settings cache —
    // the direct write did neither, so the bot could stay on for a full cache
    // TTL after someone had turned it off.
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates: { chatbot_enabled: String(newValue) } }),
    });
    setEnabled(newValue);
    setLoading(false);
  }

  return (
    <div>
      {showConfirm && (
        <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-lg">
          <p className="text-sm text-red-700 mb-3">
            This will stop the AI from responding to all customer messages. Are
            you sure?
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => applyToggle(false)}
            >
              Yes, disable
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowConfirm(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        disabled={loading}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
          enabled ? "bg-green-500" : "bg-gray-300"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            enabled ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
      <span className="ml-3 text-sm text-gray-600">
        {enabled ? "Chatbot active" : "Chatbot disabled"}
      </span>
    </div>
  );
}
