"use client";

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { PendingAction } from "@/lib/claude/assistant-tools";

// Web Speech API types not included in TypeScript's DOM lib
interface SpeechRecognitionResult {
  readonly 0: { readonly transcript: string };
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

/** One tool call the assistant made, shown live while it works. */
type Step = { id: string; label: string; summary?: string };

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  // Only ever set on messages produced in this session — the saved thread keeps
  // the answer, not the lookups behind it.
  steps?: Step[];
};

function makeMessage(
  role: Message["role"],
  content: string,
  steps?: Step[],
): Message {
  return { id: crypto.randomUUID(), role, content, steps };
}

type StreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "text"; delta: string }
  | { type: "step"; id: string; label: string }
  | { type: "step_done"; id: string; summary: string }
  | { type: "pending_action"; pendingAction: PendingAction }
  | { type: "done" }
  | { type: "error"; error: string };
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
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("jarvis_tts") !== "off"
      : true,
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const briefSentRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const ttsEnabledRef = useRef(ttsEnabled);
  ttsEnabledRef.current = ttsEnabled;
  // Updated each render so STT onend can access current handleSendText
  const handleSendTextRef = useRef<(text: string) => void>(() => {});

  const hasSpeechRecognition =
    typeof window !== "undefined" &&
    !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);

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

  const messagesQuery = useQuery<{
    messages: Message[];
    pendingAction: PendingAction | null;
  }>({
    queryKey: ["assistant-messages", activeId],
    queryFn: async () => {
      const res = await fetch(`/api/assistant/conversations/${activeId}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Failed to load");
      return {
        messages: json.data as Message[],
        pendingAction: (json.pendingAction as PendingAction | null) ?? null,
      };
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

  function speak(text: string) {
    if (!ttsEnabledRef.current || typeof window === "undefined") return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = "id-ID";
    utt.rate = 1.05;
    window.speechSynthesis.speak(utt);
  }

  /**
   * Streams one turn from /api/assistant/stream, painting text and tool steps
   * as they arrive. The reply is only committed to `messages` at the end, so a
   * half-finished answer never looks like a finished one.
   */
  async function runStream(outgoing: Message[]) {
    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);
    setStreamText("");
    setSteps([]);
    setStreamError(null);

    let text = "";
    let localSteps: Step[] = [];
    let newConversationId: string | null = null;
    let pending: PendingAction | null = null;
    let failure: string | null = null;

    function handle(event: StreamEvent) {
      switch (event.type) {
        case "conversation":
          // Held until the stream finishes: switching activeId now would make
          // the thread query refetch and overwrite the messages mid-answer.
          newConversationId = event.conversationId;
          break;
        case "text":
          text += event.delta;
          setStreamText(text);
          break;
        case "step":
          localSteps = [...localSteps, { id: event.id, label: event.label }];
          setSteps(localSteps);
          break;
        case "step_done":
          localSteps = localSteps.map((s) =>
            s.id === event.id ? { ...s, summary: event.summary } : s,
          );
          setSteps(localSteps);
          break;
        case "pending_action":
          pending = event.pendingAction;
          break;
        case "error":
          failure = event.error;
          break;
        case "done":
          break;
      }
    }

    try {
      const res = await fetch("/api/assistant/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: outgoing as MessageParam[],
          conversationId: activeId ?? undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; the tail is a partial frame
        // that has to wait for the next chunk.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue;
          handle(JSON.parse(frame.slice(6)) as StreamEvent);
        }
      }
    } catch (err) {
      // Aborting is the admin pressing Stop, not an error — keep what arrived.
      if (!controller.signal.aborted) {
        failure = err instanceof Error ? err.message : "Terjadi kesalahan";
      }
    }

    setIsStreaming(false);
    setStreamText("");
    setSteps([]);
    abortRef.current = null;

    if (text) {
      setMessages((prev) => [
        ...prev,
        makeMessage("assistant", text, localSteps),
      ]);
    }
    if (failure) setStreamError(failure);
    setPendingAction(pending);
    if (newConversationId && newConversationId !== activeId) {
      setActiveId(newConversationId);
    }
    qc.invalidateQueries({ queryKey: ["assistant-conversations"] });
    if (newConversationId) {
      qc.invalidateQueries({
        queryKey: ["assistant-messages", newConversationId],
      });
    }

    // Voice waits for the whole answer — speech synthesis cannot narrate text
    // that is still arriving without reading half-sentences aloud.
    if (pending) {
      speak(`Perlu konfirmasi: ${(pending as PendingAction).label}`);
    } else if (text && !controller.signal.aborted) {
      speak(text);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

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
      speak(text);
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
      if (activeId === id) setActiveId(null);
      qc.invalidateQueries({ queryKey: ["assistant-conversations"] });
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: streamText and steps are not read in the body — they are listed so the view re-scrolls as the answer streams in, which is the whole point of the live bubble
  useEffect(() => {
    if (!messages.length && !isStreaming && !pendingAction) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming, streamText, steps, pendingAction]);

  function handleSendText(text: string) {
    if (!text || isStreaming) return;
    if (typeof window !== "undefined") window.speechSynthesis.cancel();

    let base = messages;
    if (pendingAction) {
      base = [
        ...messages,
        makeMessage("assistant", "Dibatalkan karena ada pesan baru."),
      ];
      setMessages(base);
      setPendingAction(null);
    }

    const newMessages: Message[] = [...base, makeMessage("user", text)];
    setMessages(newMessages);
    void runStream(newMessages);
  }
  handleSendTextRef.current = handleSendText;

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    handleSendText(trimmed);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once on mount/new-chat; runStream and setMessages are stable
  useEffect(() => {
    if (!fullPage || activeId !== null || briefSentRef.current) return;
    const today = new Date().toISOString().split("T")[0];
    if (localStorage.getItem("jarvis_last_brief") === today) {
      briefSentRef.current = true;
      return;
    }
    briefSentRef.current = true;
    localStorage.setItem("jarvis_last_brief", today);
    const text = "Berikan briefing situasi bisnis hari ini";
    const newMessages: Message[] = [makeMessage("user", text)];
    setMessages(newMessages);
    void runStream(newMessages);
  }, [fullPage, activeId]);

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

  function toggleTts() {
    setTtsEnabled((prev) => {
      const next = !prev;
      localStorage.setItem("jarvis_tts", next ? "on" : "off");
      if (!next && typeof window !== "undefined")
        window.speechSynthesis.cancel();
      return next;
    });
  }

  function startListening() {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "id-ID";
    rec.interimResults = true;
    rec.continuous = false;

    rec.onresult = (e: SpeechRecognitionEvent) => {
      const parts: string[] = [];
      for (let i = 0; i < e.results.length; i++) {
        parts.push(e.results[i][0].transcript);
      }
      setInput(parts.join(""));
    };

    rec.onend = () => {
      setIsRecording(false);
      setInput((current) => {
        const trimmed = current.trim();
        if (trimmed) {
          setTimeout(() => handleSendTextRef.current(trimmed), 0);
          return "";
        }
        return current;
      });
    };

    rec.onerror = () => setIsRecording(false);

    recognitionRef.current = rec;
    rec.start();
    setIsRecording(true);
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setIsRecording(false);
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
              <p
                className={`text-sm truncate ${c.id === activeId ? "text-[#1C1917] font-medium" : "text-[#78716C]"}`}
              >
                {c.title}
              </p>
              <p className="text-[11px] text-[#A8A29E] mt-0.5">
                {formatDate(c.updated_at)}
              </p>
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
    <div
      className="flex border border-[#EEECE8] rounded-xl overflow-hidden bg-white shadow-sm"
      style={{ height: containerHeight }}
    >
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
          <span className="flex-1 text-sm text-[#78716C] truncate">
            {activeId
              ? (conversationsQuery.data?.find((c) => c.id === activeId)
                  ?.title ?? "Obrolan")
              : "Obrolan baru"}
          </span>
          <button
            type="button"
            onClick={toggleTts}
            title={ttsEnabled ? "Matikan suara" : "Nyalakan suara"}
            className="px-2 py-1 text-base text-[#A8A29E] hover:text-[#78716C] transition-colors"
          >
            {ttsEnabled ? "🔊" : "🔇"}
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-5 px-4">
              <div className="text-center space-y-1">
                <p className="text-sm font-medium text-[#1C1917]">
                  Tanya sesuatu
                </p>
                <p className="text-xs text-[#A8A29E]">
                  Data pelanggan, pesanan, pengiriman, dan keuangan.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center max-w-xs">
                {SUGGESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => handleSendText(q)}
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
                {msg.steps && msg.steps.length > 0 && (
                  <div className="mb-2 pb-2 border-b border-[#F2F0ED]">
                    <StepList steps={msg.steps} />
                  </div>
                )}
                {msg.content}
              </div>
            </div>
          ))}

          {pendingAction && (
            <div className="flex justify-start">
              <div className="max-w-[80%] bg-white border border-[#EEECE8] shadow-sm rounded-2xl rounded-bl-none overflow-hidden">
                <div className="border-l-4 border-[#C4622D] p-3 space-y-2">
                  <p className="text-[10px] font-semibold tracking-widest uppercase text-[#C4622D]">
                    {pendingAction.dangerous
                      ? "⚠ Tindakan Berbahaya"
                      : "Konfirmasi Tindakan"}
                  </p>
                  <p className="text-sm font-medium text-[#1C1917]">
                    {pendingAction.label}
                  </p>
                  <ul className="space-y-1">
                    {pendingAction.details.map((d) => (
                      <li
                        key={d}
                        className="flex gap-1.5 text-sm text-[#57534E]"
                      >
                        <span className="text-[#C4622D] mt-0.5 shrink-0">
                          ·
                        </span>
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

          {isStreaming && (
            <div className="flex justify-start">
              <div className="max-w-[80%] bg-white border border-[#EEECE8] shadow-sm px-4 py-2.5 rounded-2xl rounded-bl-none space-y-2">
                <StepList steps={steps} />
                {streamText ? (
                  <p className="text-sm whitespace-pre-wrap leading-relaxed text-[#292524]">
                    {streamText}
                  </p>
                ) : (
                  <div className="flex gap-1 items-center py-1">
                    <span className="w-1.5 h-1.5 bg-[#A8A29E] rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <span className="w-1.5 h-1.5 bg-[#A8A29E] rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <span className="w-1.5 h-1.5 bg-[#A8A29E] rounded-full animate-bounce" />
                  </div>
                )}
              </div>
            </div>
          )}

          {streamError && (
            <div className="flex justify-start">
              <div className="max-w-[80%] bg-red-50 border border-red-100 text-red-700 px-4 py-2.5 rounded-2xl rounded-bl-none text-sm">
                {streamError}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-[#EEECE8] px-3 py-3 bg-white">
          {/* Desktop TTS toggle */}
          <div className="hidden md:flex justify-end mb-1.5">
            <button
              type="button"
              onClick={toggleTts}
              title={ttsEnabled ? "Matikan suara" : "Nyalakan suara"}
              className="px-2 py-0.5 text-sm text-[#A8A29E] hover:text-[#78716C] transition-colors"
            >
              {ttsEnabled ? "🔊" : "🔇"}
            </button>
          </div>
          <div className="flex gap-2 items-end">
            {hasSpeechRecognition && (
              <button
                type="button"
                onClick={isRecording ? stopListening : startListening}
                disabled={isStreaming}
                title={isRecording ? "Berhenti merekam" : "Bicara"}
                className={`self-end p-2.5 rounded-xl border transition-colors disabled:opacity-40 ${
                  isRecording
                    ? "border-red-400 bg-red-50 text-red-500 animate-pulse"
                    : "border-[#DDD9D4] text-[#78716C] hover:border-[#C4622D] hover:text-[#C4622D]"
                }`}
              >
                🎙
              </button>
            )}
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
              disabled={isStreaming}
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={handleStop}
                className="self-end px-4 py-2.5 rounded-xl border border-[#DDD9D4] text-[#78716C] text-sm font-medium hover:border-red-400 hover:text-red-500 transition-colors"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim()}
                className="self-end px-4 py-2.5 rounded-xl bg-[#C4622D] text-white text-sm font-medium disabled:opacity-40 hover:bg-[#A8521F] transition-colors"
              >
                Kirim
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The assistant's lookups, one dim line each. Collapsed behind a summary once
 * there is more than a couple, so a long run doesn't push the answer off a
 * phone screen.
 */
function StepList({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;

  const list = (
    <ul className="space-y-0.5">
      {steps.map((s) => (
        <li key={s.id} className="text-[11px] text-[#A8A29E] leading-snug">
          <span className={s.summary ? "" : "animate-pulse"}>
            {s.summary ? "✓" : "○"} {s.label}
          </span>
          {s.summary && (
            <span className="text-[#C4C0BB]"> — {s.summary}</span>
          )}
        </li>
      ))}
    </ul>
  );

  if (steps.length <= 3) return list;

  return (
    <details className="group">
      <summary className="text-[11px] text-[#A8A29E] cursor-pointer list-none">
        {steps.length} langkah pencarian
        <span className="group-open:hidden"> ▸</span>
        <span className="hidden group-open:inline"> ▾</span>
      </summary>
      <div className="mt-1">{list}</div>
    </details>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("id-ID", { month: "short", day: "numeric" });
}
