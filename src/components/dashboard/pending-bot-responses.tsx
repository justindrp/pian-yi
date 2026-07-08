"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";

interface PendingChat {
  customer_id: string;
  pending_bot_question: string | null;
  customer_name: string | null;
}

interface CardState {
  botReply: string;
  botReplyPreview: string | null;
  saveBotReplyAsRule: boolean;
  sending: boolean;
  confirming: boolean;
}

function defaultCardState(): CardState {
  return {
    botReply: "",
    botReplyPreview: null,
    saveBotReplyAsRule: false,
    sending: false,
    confirming: false,
  };
}

function PendingCard({
  chat,
  onDone,
}: {
  chat: PendingChat;
  onDone: () => void;
}) {
  const [state, setState] = useState<CardState>(defaultCardState);

  function update(patch: Partial<CardState>) {
    setState((s) => ({ ...s, ...patch }));
  }

  async function preview() {
    if (!state.botReply.trim()) return;
    update({ sending: true });
    const res = await fetch("/api/inbox/bot-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: chat.customer_id,
        admin_answer: state.botReply.trim(),
        preview_only: true,
      }),
    });
    update({ sending: false });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      alert(`Failed to preview: ${body?.error ?? res.statusText}`);
      return;
    }
    const body = (await res.json()) as { preview?: string };
    update({ botReplyPreview: body.preview ?? state.botReply.trim() });
  }

  async function confirm() {
    if (!state.botReplyPreview) return;
    update({ confirming: true });
    const res = await fetch("/api/inbox/bot-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: chat.customer_id,
        polished_text: state.botReplyPreview,
        admin_answer: state.botReply.trim(),
        save_as_rule: state.saveBotReplyAsRule,
      }),
    });
    update({ confirming: false });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      alert(`Failed to send: ${body?.error ?? res.statusText}`);
      return;
    }
    onDone();
  }

  return (
    <div className="border border-amber-200 bg-amber-50 rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-2">
        <span className="text-amber-600 text-sm mt-0.5">⏳</span>
        <div>
          <p className="text-sm font-medium text-amber-800">
            {chat.customer_name ?? "Unknown customer"} — bot is waiting for your answer
          </p>
          {chat.pending_bot_question && (
            <p className="text-xs text-amber-700 mt-0.5 italic">
              "{chat.pending_bot_question}"
            </p>
          )}
        </div>
      </div>

      {state.botReplyPreview ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-amber-800">AI will send this:</p>
          <p className="text-sm text-amber-900 bg-white border border-amber-200 rounded-lg px-3 py-2 whitespace-pre-wrap">
            {state.botReplyPreview}
          </p>
          <label className="flex items-center gap-2 text-xs text-amber-800">
            <input
              type="checkbox"
              checked={state.saveBotReplyAsRule}
              onChange={(e) => update({ saveBotReplyAsRule: e.target.checked })}
            />
            Save as permanent bot rule (applies to all future customers)
          </label>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={confirm}
              disabled={state.confirming}
              className="bg-amber-500 text-white hover:bg-amber-600"
            >
              {state.confirming ? "Sending..." : "Send"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => update({ botReplyPreview: null, saveBotReplyAsRule: false })}
              disabled={state.confirming}
              className="border-amber-200 text-amber-700 hover:bg-amber-100"
            >
              Edit
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Textarea
            value={state.botReply}
            onChange={(e) => update({ botReply: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void preview();
              }
            }}
            placeholder="Type your answer (AI will polish it)..."
            rows={3}
            className="flex-1 min-h-0 resize-none border-amber-200 focus-visible:ring-amber-400"
          />
          <Button
            type="button"
            onClick={preview}
            disabled={state.sending || !state.botReply.trim()}
            className="bg-amber-500 text-white hover:bg-amber-600"
          >
            {state.sending ? "Previewing..." : "Preview"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PendingBotResponses() {
  const [chats, setChats] = useState<PendingChat[]>([]);
  const supabase = createClient();

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("customer_flags")
      .select("customer_id, pending_bot_question, customers(name)")
      .eq("pending_bot_response", true);
    if (!data) return;
    setChats(
      data.map((row) => ({
        customer_id: row.customer_id,
        pending_bot_question: row.pending_bot_question,
        customer_name: Array.isArray(row.customers)
          ? (row.customers[0]?.name ?? null)
          : ((row.customers as { name: string } | null)?.name ?? null),
      })),
    );
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  if (chats.length === 0) return null;

  return (
    <div className="py-4 border-b space-y-3">
      <p className="text-sm font-medium text-amber-800">
        ⏳ Pending bot responses ({chats.length})
      </p>
      {chats.map((chat) => (
        <PendingCard
          key={chat.customer_id}
          chat={chat}
          onDone={() => setChats((prev) => prev.filter((c) => c.customer_id !== chat.customer_id))}
        />
      ))}
    </div>
  );
}
