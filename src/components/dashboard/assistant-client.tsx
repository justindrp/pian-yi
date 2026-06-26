"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { PendingAction } from "@/lib/claude/assistant-tools";

type Message = { role: "user" | "assistant"; content: string };

interface AssistantClientProps {
  fullPage?: boolean;
}

export function AssistantClient({ fullPage = false }: AssistantClientProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: async (newMessages: Message[]) => {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages as MessageParam[] }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Request failed");
      return json as { text: string; pendingAction?: PendingAction };
    },
    onSuccess: (data) => {
      if (data.text) {
        setMessages((prev) => [...prev, { role: "assistant", content: data.text }]);
      }
      setPendingAction(data.pendingAction ?? null);
    },
  });

  const confirm = useMutation({
    mutationFn: async (action: PendingAction) => {
      const res = await fetch("/api/assistant/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: action.tool, input: action.input }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Execute failed");
      return json.text as string;
    },
    onSuccess: (text) => {
      setMessages((prev) => [...prev, { role: "assistant", content: text }]);
      setPendingAction(null);
    },
    onError: (err) => {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Gagal: ${err.message}` },
      ]);
      setPendingAction(null);
    },
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, send.isPending, pendingAction]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || send.isPending) return;

    let base = messages;
    if (pendingAction) {
      base = [...messages, { role: "assistant", content: "Dibatalkan karena ada pesan baru." }];
      setMessages(base);
      setPendingAction(null);
    }

    const newMessages: Message[] = [...base, { role: "user", content: trimmed }];
    setMessages(newMessages);
    setInput("");
    send.mutate(newMessages);
  }

  function handleConfirm() {
    if (!pendingAction || confirm.isPending) return;
    confirm.mutate(pendingAction);
  }

  function handleCancel() {
    setMessages((prev) => [...prev, { role: "assistant", content: "Dibatalkan." }]);
    setPendingAction(null);
  }

  const containerHeight = fullPage ? "calc(100vh - 130px)" : "460px";

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
        style={{ height: containerHeight }}
      >
        {messages.length === 0 && (
          <div className="text-center text-gray-400 text-sm mt-8">
            Ask anything about customers, orders, deliveries, or financials.
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-800"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {pendingAction && (
          <div className="flex justify-start">
            <div className="max-w-[80%] border rounded-2xl p-3 bg-amber-50 border-amber-200 space-y-2 text-sm">
              <p className="font-medium text-amber-900">{pendingAction.label}</p>
              <ul className="space-y-0.5 text-amber-800">
                {pendingAction.details.map((d) => (
                  <li key={d}>• {d}</li>
                ))}
              </ul>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={confirm.isPending}
                  className={`px-3 py-1.5 rounded-lg text-white text-xs font-medium disabled:opacity-50 ${
                    pendingAction.dangerous ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
                  }`}
                >
                  {confirm.isPending ? "..." : "Confirm"}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={confirm.isPending}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
        {send.isPending && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-500 px-4 py-2.5 rounded-2xl text-sm">
              ...
            </div>
          </div>
        )}
        {send.isError && (
          <div className="flex justify-start">
            <div className="bg-red-50 text-red-600 px-4 py-2.5 rounded-2xl text-sm">
              Error: {send.error?.message}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t px-3 py-2 flex gap-2">
        <textarea
          className="flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          rows={2}
          placeholder="Ask about your business data..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={send.isPending}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={send.isPending || !input.trim()}
          className="self-end px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium disabled:opacity-50 hover:bg-blue-700 transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
