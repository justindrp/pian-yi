"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

type Message = { role: "user" | "assistant"; content: string };

interface AssistantClientProps {
  fullPage?: boolean;
}

export function AssistantClient({ fullPage = false }: AssistantClientProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
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
      return json.text as string;
    },
    onSuccess: (text) => {
      setMessages((prev) => [...prev, { role: "assistant", content: text }]);
    },
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, send.isPending]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || send.isPending) return;
    const newMessages: Message[] = [...messages, { role: "user", content: trimmed }];
    setMessages(newMessages);
    setInput("");
    send.mutate(newMessages);
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
