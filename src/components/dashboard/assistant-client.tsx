"use client";

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { PendingAction } from "@/lib/claude/assistant-tools";

type Message = { id: string; role: "user" | "assistant"; content: string };

function makeMessage(role: Message["role"], content: string): Message {
  return { id: crypto.randomUUID(), role, content };
}
type Conversation = { id: string; title: string; updated_at: string };

interface AssistantClientProps {
  fullPage?: boolean;
}

export function AssistantClient({ fullPage = false }: AssistantClientProps) {
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversationsQuery = useQuery<Conversation[]>({
    queryKey: ["assistant-conversations"],
    queryFn: async () => {
      const res = await fetch("/api/assistant/conversations");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Failed to load");
      return json.data as Conversation[];
    },
    refetchOnWindowFocus: true,
  });

  const messagesQuery = useQuery<Message[]>({
    queryKey: ["assistant-messages", activeId],
    queryFn: async () => {
      const res = await fetch(`/api/assistant/conversations/${activeId}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Failed to load");
      return json.data as Message[];
    },
    enabled: !!activeId,
  });

  // Reconcile local message state whenever the active conversation's server view changes.
  useEffect(() => {
    if (activeId && messagesQuery.data) {
      setMessages(messagesQuery.data);
      setPendingAction(null);
    }
    if (!activeId) {
      setMessages([]);
      setPendingAction(null);
    }
  }, [activeId, messagesQuery.data]);

  function invalidateLists() {
    qc.invalidateQueries({ queryKey: ["assistant-conversations"] });
    if (activeId)
      qc.invalidateQueries({ queryKey: ["assistant-messages", activeId] });
  }

  const send = useMutation({
    mutationFn: async (payload: {
      messages: Message[];
      conversationId?: string;
    }) => {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: payload.messages as MessageParam[],
          conversationId: payload.conversationId,
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Request failed");
      return json as {
        text: string;
        pendingAction?: PendingAction;
        conversationId?: string;
      };
    },
    onSuccess: (data) => {
      if (data.conversationId && data.conversationId !== activeId) {
        setActiveId(data.conversationId);
      }
      if (data.text) {
        setMessages((prev) => [...prev, makeMessage("assistant", data.text)]);
      }
      setPendingAction(data.pendingAction ?? null);
      qc.invalidateQueries({ queryKey: ["assistant-conversations"] });
      if (data.conversationId) {
        qc.invalidateQueries({
          queryKey: ["assistant-messages", data.conversationId],
        });
      }
    },
  });

  const confirm = useMutation({
    mutationFn: async (action: PendingAction) => {
      const res = await fetch("/api/assistant/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: action.tool,
          input: action.input,
          conversationId: activeId ?? undefined,
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Execute failed");
      return json.text as string;
    },
    onSuccess: (text) => {
      setMessages((prev) => [...prev, makeMessage("assistant", text)]);
      setPendingAction(null);
      invalidateLists();
    },
    onError: (err) => {
      setMessages((prev) => [
        ...prev,
        makeMessage("assistant", `Gagal: ${err.message}`),
      ]);
      setPendingAction(null);
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/assistant/conversations/${id}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Delete failed");
    },
    onSuccess: (_void, id) => {
      qc.removeQueries({ queryKey: ["assistant-messages", id] });
      if (activeId === id) {
        setActiveId(null);
      }
      qc.invalidateQueries({ queryKey: ["assistant-conversations"] });
    },
  });

  useEffect(() => {
    if (!messages.length && !send.isPending && !pendingAction) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, send.isPending, pendingAction]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || send.isPending) return;

    let base = messages;
    if (pendingAction) {
      base = [
        ...messages,
        makeMessage("assistant", "Dibatalkan karena ada pesan baru."),
      ];
      setMessages(base);
      setPendingAction(null);
    }

    const newMessages: Message[] = [...base, makeMessage("user", trimmed)];
    setMessages(newMessages);
    setInput("");
    send.mutate({
      messages: newMessages,
      conversationId: activeId ?? undefined,
    });
  }

  function handleConfirm() {
    if (!pendingAction || confirm.isPending) return;
    confirm.mutate(pendingAction);
  }

  function handleCancel() {
    setMessages((prev) => [...prev, makeMessage("assistant", "Dibatalkan.")]);
    setPendingAction(null);
  }

  function handleNewChat() {
    setActiveId(null);
    setSidebarOpen(false);
  }

  function handleSelect(id: string) {
    setActiveId(id);
    setSidebarOpen(false);
  }

  const containerHeight = fullPage ? "calc(100vh - 130px)" : "460px";

  const sidebar = (
    <div className="flex flex-col h-full w-64 shrink-0 border-r bg-gray-50">
      <div className="p-2">
        <button
          type="button"
          onClick={handleNewChat}
          className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-white transition-colors text-left"
        >
          + New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {conversationsQuery.isLoading && (
          <p className="text-xs text-gray-400 px-2 py-1">Loading…</p>
        )}
        {conversationsQuery.data?.length === 0 && (
          <p className="text-xs text-gray-400 px-2 py-1">
            No conversations yet.
          </p>
        )}
        {conversationsQuery.data?.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center gap-1 rounded-lg ${
              c.id === activeId ? "bg-blue-100" : "hover:bg-gray-200"
            }`}
          >
            <button
              type="button"
              onClick={() => handleSelect(c.id)}
              className="flex-1 min-w-0 px-2.5 py-2 text-left"
            >
              <p className="text-sm truncate text-gray-800">{c.title}</p>
              <p className="text-[11px] text-gray-400">
                {formatDate(c.updated_at)}
              </p>
            </button>
            <button
              type="button"
              onClick={() => remove.mutate(c.id)}
              disabled={remove.isPending}
              title="Delete"
              className="opacity-0 group-hover:opacity-100 px-2 py-2 text-gray-400 hover:text-red-600 text-sm"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">{sidebar}</div>

      {/* Mobile drawer */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          />
          <div className="relative z-10 h-full">{sidebar}</div>
        </div>
      )}

      {/* Chat pane */}
      <div className="flex flex-col flex-1 min-w-0">
        <div className="md:hidden flex items-center gap-2 px-3 py-2 border-b">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="px-2 py-1 rounded-lg border border-gray-300 text-sm"
          >
            ☰
          </button>
          <span className="text-sm text-gray-500 truncate">
            {activeId
              ? (conversationsQuery.data?.find((c) => c.id === activeId)
                  ?.title ?? "Chat")
              : "New chat"}
          </span>
        </div>

        <div
          className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
          style={{ height: containerHeight }}
        >
          {messages.length === 0 && (
            <div className="text-center text-gray-400 text-sm mt-8">
              Ask anything about customers, orders, deliveries, or financials.
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
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
                <p className="font-medium text-amber-900">
                  {pendingAction.label}
                </p>
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
                      pendingAction.dangerous
                        ? "bg-red-600 hover:bg-red-700"
                        : "bg-blue-600 hover:bg-blue-700"
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
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
