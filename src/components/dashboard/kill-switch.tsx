"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

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
    const supabase = createClient();
    await supabase
      .from("settings")
      .update({ value: String(newValue), updated_at: new Date().toISOString() })
      .eq("key", "chatbot_enabled");
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
            <button
              type="button"
              onClick={() => applyToggle(false)}
              className="px-3 py-1.5 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700"
            >
              Yes, disable
            </button>
            <button
              type="button"
              onClick={() => setShowConfirm(false)}
              className="px-3 py-1.5 bg-white border border-gray-200 text-sm rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
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
