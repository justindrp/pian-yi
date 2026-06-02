"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

interface Recipient {
  customer_id: string;
  name: string;
  phone_number: string;
  area: string;
  personalized_message: string;
}

interface BroadcastRecipient {
  id: string;
  customer_id: string;
  phone_number: string;
  personalized_message: string;
  status: "sent" | "failed";
  error: string | null;
  sent_at: string | null;
  customers: { name: string | null; area: string } | null;
}

interface Broadcast {
  id: string;
  created_at: string;
  created_by: string;
  instruction: string;
  message_template: string;
  recipient_count: number;
  status: "sent" | "failed";
  broadcast_recipients: BroadcastRecipient[];
}

interface Preview {
  filter: Record<string, unknown>;
  message_template: string;
  recipients: Recipient[];
}

export default function BroadcastsClient() {
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [editedMessage, setEditedMessage] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ["broadcasts"],
    queryFn: async () => {
      const res = await fetch("/api/broadcasts");
      const json = await res.json() as { ok: boolean; data: Broadcast[] };
      return json.data;
    },
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/broadcasts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      const json = await res.json() as { ok: boolean; data: Preview; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Preview failed");
      return json.data;
    },
    onSuccess: (data) => {
      setPreview(data);
      setEditedMessage(data.message_template);
    },
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!preview) return;
      const recipients = preview.recipients.map((r) => ({
        customer_id: r.customer_id,
        phone_number: r.phone_number,
        personalized_message: editedMessage.replace(/\{name\}/g, r.name),
      }));
      const res = await fetch("/api/broadcasts/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction,
          message_template: editedMessage,
          filter: preview.filter,
          recipients,
        }),
      });
      const json = await res.json() as { ok: boolean; data: { sent: number; failed: number }; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Send failed");
      return json.data;
    },
    onSuccess: () => {
      setPreview(null);
      setInstruction("");
      setEditedMessage("");
      qc.invalidateQueries({ queryKey: ["broadcasts"] });
    },
  });

  function reset() {
    setPreview(null);
    setEditedMessage("");
    previewMutation.reset();
    sendMutation.reset();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-gray-900">Broadcasts</h1>

      {/* Compose */}
      <div className="bg-white border border-gray-100 rounded-xl p-5 space-y-4">
        <h2 className="font-medium text-gray-700 text-sm">New Broadcast</h2>
        <div>
          <label className="block text-xs text-gray-500 mb-1">What do you want to send?</label>
          <textarea
            value={instruction}
            onChange={(e) => { setInstruction(e.target.value); reset(); }}
            placeholder="e.g. Offer a 10% discount to all Alam Sutera customers this week"
            rows={3}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 resize-none focus:outline-none focus:ring-1 focus:ring-gray-400"
          />
        </div>

        {!preview && (
          <button
            type="button"
            onClick={() => previewMutation.mutate()}
            disabled={!instruction.trim() || previewMutation.isPending}
            className="px-4 py-2 bg-gray-900 text-white text-sm rounded-lg disabled:opacity-40 hover:bg-gray-800"
          >
            {previewMutation.isPending ? "Generating preview..." : "Preview"}
          </button>
        )}

        {previewMutation.isError && (
          <p className="text-sm text-red-500">{previewMutation.error.message}</p>
        )}

        {/* Preview panel */}
        {preview && (
          <div className="space-y-4 border-t border-gray-100 pt-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-gray-500">Message (editable)</label>
                <span className="text-xs text-gray-400">Use {"{name}"} for personalization</span>
              </div>
              <textarea
                value={editedMessage}
                onChange={(e) => setEditedMessage(e.target.value)}
                rows={5}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 resize-none focus:outline-none focus:ring-1 focus:ring-gray-400"
              />
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-2">
                Recipients — <span className="font-medium text-gray-900">{preview.recipients.length} customers</span>
              </div>
              <div className="max-h-48 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
                {preview.recipients.length === 0 ? (
                  <p className="text-sm text-gray-400 px-3 py-3">No customers match this filter.</p>
                ) : (
                  preview.recipients.map((r) => (
                    <div key={r.customer_id} className="px-3 py-2 flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-gray-900">{r.name}</span>
                        <span className="text-xs text-gray-400 ml-2">{r.area}</span>
                      </div>
                      <span className="text-xs text-gray-400">{r.phone_number}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              Note: WhatsApp may reject messages to customers who haven't messaged in the last 24 hours.
            </div>

            {sendMutation.isError && (
              <p className="text-sm text-red-500">{sendMutation.error.message}</p>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => sendMutation.mutate()}
                disabled={sendMutation.isPending || preview.recipients.length === 0 || !editedMessage.trim()}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-40 hover:bg-blue-700"
              >
                {sendMutation.isPending ? "Sending..." : `Send to ${preview.recipients.length} customers`}
              </button>
              <button type="button" onClick={reset} className="px-4 py-2 border border-gray-200 text-sm rounded-lg text-gray-600 hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </div>
        )}

        {sendMutation.isSuccess && sendMutation.data && (
          <div className="text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
            Sent to {sendMutation.data.sent} customers.
            {sendMutation.data.failed > 0 && ` ${sendMutation.data.failed} failed — check history for details.`}
          </div>
        )}
      </div>

      {/* History */}
      <div>
        <h2 className="font-medium text-gray-700 text-sm mb-3">History</h2>
        {historyLoading ? (
          <div className="text-sm text-gray-400">Loading...</div>
        ) : !history?.length ? (
          <div className="text-sm text-gray-400">No broadcasts yet.</div>
        ) : (
          <div className="space-y-2">
            {history.map((b) => {
              const sent = b.broadcast_recipients.filter((r) => r.status === "sent").length;
              const failed = b.broadcast_recipients.filter((r) => r.status === "failed").length;
              const isExpanded = expandedId === b.id;
              return (
                <div key={b.id} className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : b.id)}
                    className="w-full px-5 py-4 flex items-center gap-4 text-left hover:bg-gray-50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">{b.instruction}</div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {new Date(b.created_at).toLocaleString("id-ID")} · {b.created_by}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-xs text-gray-500">{sent} sent{failed > 0 ? `, ${failed} failed` : ""}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${b.status === "sent" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
                        {b.status}
                      </span>
                      <span className="text-gray-300 text-xs">{isExpanded ? "▲" : "▼"}</span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-gray-100 px-5 py-4 space-y-3">
                      <div>
                        <div className="text-xs text-gray-400 mb-1">Message sent</div>
                        <p className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded-lg px-3 py-2">{b.message_template}</p>
                      </div>
                      <div>
                        <div className="text-xs text-gray-400 mb-1">Recipients</div>
                        <div className="border border-gray-100 rounded-lg divide-y divide-gray-50">
                          {b.broadcast_recipients.map((r) => (
                            <div key={r.id} className="px-3 py-2 flex items-center justify-between">
                              <div>
                                <span className="text-sm text-gray-900">{r.customers?.name ?? r.phone_number}</span>
                                {r.customers?.area && <span className="text-xs text-gray-400 ml-2">{r.customers.area}</span>}
                              </div>
                              <div className="flex items-center gap-2">
                                {r.error && <span className="text-xs text-red-400">{r.error}</span>}
                                <span className={`text-xs px-1.5 py-0.5 rounded-full ${r.status === "sent" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-500"}`}>
                                  {r.status}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
