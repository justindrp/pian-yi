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

const SUGGESTIONS = [
  "Berapa pesanan aktif hari ini?",
  "Pelanggan baru minggu ini?",
  "Total pendapatan bulan ini?",
  "Siapa yang belum bayar?",
];

export function AssistantClient({ fullPage = false }: AssistantClientProps) {
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
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

  const messagesQuery = useQuery<{ messages: Message[]; pendingAction: PendingAction | null }>({
    queryKey: ["assistant-messages", activeId],
    queryFn: async () => {
      const res = await fetch(`/api/assistant/conversations/${activeId}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Failed to load");
      return { messages: json.data as Message[], pendingAction: (json.pendingAction as PendingAction | null) ?? null };
    },
    enabled: !!activeId,
  });

  useEffect(() => {
    if (activeId && messagesQuery.data) {
      setMessages(messagesQuery.data.messages);
      setPendingAction(messagesQuery.data.pendingAction);
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
    mutationFn: async (payload: { messages: Message[]; conversationId?: string }) => {
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
      return json as { text: string; pendingAction?: PendingAction; conversationId?: string };
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
        qc.invalidateQueries({ queryKey: ["assistant-messages", data.conversationId] });
      }
    },
  });

  const confirm = useMutation({
    mutationFn: async (action: PendingAction) => {
      const res = await fetch("/api/assistant/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: action.tool, input: action.input, conversationId: activeId ?? undefined }),
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
      setMessages((prev) => [...prev, makeMessage("assistant", `Gagal: ${err.message}`)]);
      setPendingAction(null);
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/assistant/conversations/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Delete failed");
    },
    onSuccess: (_void, id) => {
      qc.removeQueries({ queryKey: ["assistant-messages", id] });
      if (activeId === id) setActiveId(null);
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
      base = [...messages, makeMessage("assistant", "Dibatalkan karena ada pesan baru.")];
      setMessages(base);
      setPendingAction(null);
    }

    const newMessages: Message[] = [...base, makeMessage("user", trimmed)];
    setMessages(newMessages);
    setInput("");
    send.mutate({ messages: newMessages, conversationId: activeId ?? undefined });
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

  const containerHeight = fullPage ? "calc(100vh - 200px)" : "460px";

  const sidebar = (
    <div className="flex flex-col h-full w-60 shrink-0 border-r border-[#EEECE8] bg-[#F7F5F2]">
      <div className="p-3 border-b border-[#EEECE8]">
        <p className="text-[10px] font-semibold tracking-widest text-[#A8A29E] uppercase px-1 mb-2">
          Riwayat
        </p>
        <button
          type="button"
          onClick={handleNewChat}
          className="w-full px-3 py-2 rounded-lg border border-[#DDD9D4] text-sm text-[#57534E] hover:border-[#C4622D] hover:text-[#C4622D] transition-colors text-left"
        >
          + Obrolan baru
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {conversationsQuery.isLoading && (
          <p className="text-xs text-[#A8A29E] px-3 py-2">Memuat…</p>
        )}
        {conversationsQuery.data?.length === 0 && (
          <p className="text-xs text-[#A8A29E] px-3 py-2 leading-relaxed">
            Belum ada obrolan.
          </p>
        )}
        {conversationsQuery.data?.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center rounded-lg border-l-[3px] transition-colors ${
              c.id === activeId
                ? "border-[#C4622D] bg-white"
                : "border-transparent hover:bg-[#EEECe8]"
            }`}
          >
            <button
              type="button"
              onClick={() => handleSelect(c.id)}
              className="flex-1 min-w-0 px-2.5 py-2 text-left"
            >
              <p className={`text-sm truncate ${c.id === activeId ? "text-[#1C1917] font-medium" : "text-[#78716C]"}`}>
                {c.title}
              </p>
              <p className="text-[11px] text-[#A8A29E] mt-0.5">{formatDate(c.updated_at)}</p>
            </button>
            <button
              type="button"
              onClick={() => remove.mutate(c.id)}
              disabled={remove.isPending}
              title="Hapus"
              className="opacity-0 group-hover:opacity-100 px-2 py-2 text-[#A8A29E] hover:text-red-500 text-xs transition-opacity"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex border border-[#EEECE8] rounded-xl overflow-hidden bg-white shadow-sm" style={{ height: containerHeight }}>
      {/* Desktop sidebar */}
      <div className="hidden md:flex h-full">{sidebar}</div>

      {/* Mobile drawer */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            onClick={() => setSidebarOpen(false)}
            aria-label="Tutup"
          />
          <div className="relative z-10 h-full">{sidebar}</div>
        </div>
      )}

      {/* Chat pane */}
      <div className="flex flex-col flex-1 min-w-0 bg-[#FAFAF8]">
        {/* Mobile header */}
        <div className="md:hidden flex items-center gap-2 px-3 py-2 border-b border-[#EEECE8] bg-white">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="px-2 py-1 rounded-lg border border-[#DDD9D4] text-sm text-[#78716C]"
          >
            ☰
          </button>
          <span className="text-sm text-[#78716C] truncate">
            {activeId
              ? (conversationsQuery.data?.find((c) => c.id === activeId)?.title ?? "Obrolan")
              : "Obrolan baru"}
          </span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-5 px-4">
              <div className="text-center space-y-1">
                <p className="text-sm font-medium text-[#1C1917]">Tanya sesuatu</p>
                <p className="text-xs text-[#A8A29E]">Data pelanggan, pesanan, pengiriman, dan keuangan.</p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center max-w-xs">
                {SUGGESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setInput(q)}
                    className="px-3 py-1.5 rounded-full border border-[#DDD9D4] text-xs text-[#78716C] hover:border-[#C4622D] hover:text-[#C4622D] bg-white transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
                  msg.role === "user"
                    ? "bg-[#1C1917] text-white rounded-2xl rounded-br-none"
                    : "bg-white border border-[#EEECE8] shadow-sm text-[#292524] rounded-2xl rounded-bl-none"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {pendingAction && (
            <div className="flex justify-start">
              <div className="max-w-[80%] bg-white border border-[#EEECE8] shadow-sm rounded-2xl rounded-bl-none overflow-hidden">
                <div className="border-l-4 border-[#C4622D] p-3 space-y-2">
                  <p className="text-[10px] font-semibold tracking-widest uppercase text-[#C4622D]">
                    {pendingAction.dangerous ? "⚠ Tindakan Berbahaya" : "Konfirmasi Tindakan"}
                  </p>
                  <p className="text-sm font-medium text-[#1C1917]">{pendingAction.label}</p>
                  <ul className="space-y-1">
                    {pendingAction.details.map((d) => (
                      <li key={d} className="flex gap-1.5 text-sm text-[#57534E]">
                        <span className="text-[#C4622D] mt-0.5 shrink-0">·</span>
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleConfirm}
                      disabled={confirm.isPending}
                      className={`px-3 py-1.5 rounded-lg text-white text-xs font-medium disabled:opacity-50 transition-colors ${
                        pendingAction.dangerous
                          ? "bg-red-600 hover:bg-red-700"
                          : "bg-[#C4622D] hover:bg-[#A8521F]"
                      }`}
                    >
                      {confirm.isPending ? "Memproses…" : "Konfirmasi"}
                    </button>
                    <button
                      type="button"
                      onClick={handleCancel}
                      disabled={confirm.isPending}
                      className="px-3 py-1.5 rounded-lg border border-[#DDD9D4] text-xs text-[#78716C] hover:bg-[#F7F5F2] disabled:opacity-50 transition-colors"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {send.isPending && (
            <div className="flex justify-start">
              <div className="bg-white border border-[#EEECE8] shadow-sm px-4 py-3 rounded-2xl rounded-bl-none flex gap-1 items-center">
                <span className="w-1.5 h-1.5 bg-[#A8A29E] rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 bg-[#A8A29E] rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 bg-[#A8A29E] rounded-full animate-bounce" />
              </div>
            </div>
          )}

          {send.isError && (
            <div className="flex justify-start">
              <div className="max-w-[80%] bg-red-50 border border-red-100 text-red-700 px-4 py-2.5 rounded-2xl rounded-bl-none text-sm">
                {send.error?.message}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-[#EEECE8] px-3 py-3 bg-white">
          <div className="flex gap-2 items-end">
            <textarea
              className="flex-1 resize-none rounded-xl border border-[#DDD9D4] bg-[#FAFAF8] px-3 py-2.5 text-sm text-[#1C1917] placeholder:text-[#A8A29E] focus:outline-none focus:ring-2 focus:ring-[#C4622D]/20 focus:border-[#C4622D] transition-colors"
              rows={2}
              placeholder="Tanya tentang data bisnis… (Enter untuk kirim)"
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
              className="self-end px-4 py-2.5 rounded-xl bg-[#C4622D] text-white text-sm font-medium disabled:opacity-40 hover:bg-[#A8521F] transition-colors"
            >
              Kirim
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("id-ID", { month: "short", day: "numeric" });
}
