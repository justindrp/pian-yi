"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime, maskPhone } from "@/lib/utils/format";
import type { Database } from "@/types/database";

type Conversation = Database["public"]["Tables"]["conversations"]["Row"];
type Customer = Database["public"]["Tables"]["customers"]["Row"];

interface Thread {
  customer: Customer;
  lastMessage: Conversation;
  unread: boolean;
  menuShown: boolean;
}

export default function InboxClient() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    null,
  );
  const [messages, setMessages] = useState<Conversation[]>([]);
  const [manualReply, setManualReply] = useState("");
  const [sending, setSending] = useState(false);
  const [flags, setFlags] = useState<{ escalated_to_human: boolean } | null>(
    null,
  );
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const bottomRef = useRef<HTMLDivElement>(null);
  const supabase = useMemo(() => createClient(), []);
  // Ref so the realtime callback always sees the latest value without re-subscribing
  const selectedCustomerIdRef = useRef<string | null>(null);

  const loadThreads = useCallback(async () => {
    const { data } = await supabase
      .from("conversations")
      .select("*, customers(*)")
      .order("created_at", { ascending: false })
      .limit(500);

    if (!data) return;

    const seen = new Set<string>();
    const grouped: Thread[] = [];

    for (const row of data) {
      const customerId = row.customer_id;
      if (!customerId || seen.has(customerId)) continue;
      seen.add(customerId);
      grouped.push({
        customer: row.customers as unknown as Customer,
        lastMessage: row,
        unread: row.role === "user",
        menuShown: false,
      });
    }

    if (grouped.length > 0) {
      const customerIds = grouped.map((t) => t.customer.id);
      const { data: stateData } = await supabase
        .from("customer_state")
        .select("customer_id, menu_shown")
        .in("customer_id", customerIds);
      const menuShownMap = new Map(
        (stateData ?? []).map((s) => [s.customer_id, s.menu_shown ?? false]),
      );
      for (const thread of grouped) {
        thread.menuShown = menuShownMap.get(thread.customer.id) ?? false;
      }
    }

    setThreads(grouped);
  }, [supabase]);

  const loadMessages = useCallback(
    async (customerId: string) => {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: true });
      setMessages(data ?? []);

      const { data: flagData } = await supabase
        .from("customer_flags")
        .select("escalated_to_human")
        .eq("customer_id", customerId)
        .single();
      setFlags(
        flagData
          ? { escalated_to_human: flagData.escalated_to_human ?? false }
          : null,
      );
    },
    [supabase],
  );

  // Keep the ref in sync with state
  useEffect(() => {
    selectedCustomerIdRef.current = selectedCustomerId;
  }, [selectedCustomerId]);

  // Set up realtime channel once — never torn down when thread selection changes
  useEffect(() => {
    void loadThreads();

    const channel = supabase
      .channel("conversations-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "conversations" },
        () => {
          void loadThreads();
          const current = selectedCustomerIdRef.current;
          if (current) void loadMessages(current);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadThreads, loadMessages, supabase]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message change only
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function selectThread(customerId: string) {
    setSelectedCustomerId(customerId);
    setMobileView("chat");
    await loadMessages(customerId);
  }

  async function toggleEscalation() {
    if (!selectedCustomerId || !flags) return;
    const newVal = !flags.escalated_to_human;
    await supabase
      .from("customer_flags")
      .update({
        escalated_to_human: newVal,
        escalation_reason: newVal ? "Manual takeover" : null,
      })
      .eq("customer_id", selectedCustomerId);
    setFlags({ ...flags, escalated_to_human: newVal });
  }

  async function sendManualReply() {
    if (!selectedCustomerId || !manualReply.trim()) return;
    setSending(true);

    const thread = threads.find((t) => t.customer.id === selectedCustomerId);
    if (!thread) {
      setSending(false);
      return;
    }

    await supabase.from("conversations").insert({
      customer_id: selectedCustomerId,
      role: "assistant",
      content: manualReply.trim(),
      model_used: "human",
    });

    await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: thread.customer.phone_number,
        text: manualReply.trim(),
      }),
    });

    setManualReply("");
    await loadMessages(selectedCustomerId);
    setSending(false);
  }

  const selectedThread = threads.find(
    (t) => t.customer.id === selectedCustomerId,
  );

  return (
    <div className="flex h-[calc(100vh-7rem)] bg-white rounded-xl border border-gray-100 overflow-hidden">
      {/* Thread list */}
      <div className={`w-full md:w-72 flex-shrink-0 border-r border-gray-100 overflow-y-auto ${mobileView === "chat" ? "hidden md:block" : "block"}`}>
        <div className="p-4 border-b border-gray-100">
          <h1 className="text-sm font-semibold text-gray-900">Inbox</h1>
        </div>
        {threads.map((thread) => (
          <button
            type="button"
            key={thread.customer.id}
            onClick={() => selectThread(thread.customer.id)}
            className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
              selectedCustomerId === thread.customer.id ? "bg-orange-50" : ""
            }`}
          >
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-sm font-medium text-gray-900">
                {thread.customer.name ??
                  maskPhone(thread.customer.phone_number)}
              </span>
              <div className="flex items-center gap-1">
                <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${thread.menuShown ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}>
                  {thread.menuShown ? "images ✓" : "no images"}
                </span>
                {thread.unread && (
                  <span className="w-2 h-2 bg-orange-500 rounded-full" />
                )}
              </div>
            </div>
            <p className="text-xs text-gray-400 truncate">
              {thread.lastMessage.content.slice(0, 60)}
            </p>
          </button>
        ))}
        {threads.length === 0 && (
          <p className="text-xs text-gray-400 p-4">No conversations yet.</p>
        )}
      </div>

      {/* Conversation detail */}
      {selectedThread ? (
        <div className={`flex-1 flex flex-col min-w-0 ${mobileView === "list" ? "hidden md:flex" : "flex"}`}>
          {/* Header */}
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => setMobileView("list")}
                className="md:hidden text-gray-500 text-lg leading-none pr-1"
                aria-label="Back to list"
              >
                ‹
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-gray-900">
                    {selectedThread.customer.name ??
                      selectedThread.customer.phone_number}
                  </p>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${selectedThread.menuShown ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                    {selectedThread.menuShown ? "menu images sent ✓" : "menu images not sent"}
                  </span>
                </div>
                <p className="text-xs text-gray-400">
                  {maskPhone(selectedThread.customer.phone_number)}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={toggleEscalation}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                flags?.escalated_to_human
                  ? "bg-green-50 border-green-200 text-green-700 hover:bg-green-100"
                  : "bg-orange-50 border-orange-200 text-orange-700 hover:bg-orange-100"
              }`}
            >
              {flags?.escalated_to_human ? "Resume bot" : "Take over"}
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {messages.map((msg) => {
              const isUser = msg.role === "user";
              const msgWithExtras = msg as Conversation & { intent?: string | null; message_type?: string | null };
              return (
                <div
                  key={msg.id}
                  className={`flex ${isUser ? "justify-start" : "justify-end"}`}
                >
                  <div
                    className={`max-w-xs px-3 py-2 rounded-xl text-sm ${
                      isUser
                        ? "bg-gray-100 text-gray-800"
                        : "bg-orange-500 text-white"
                    }`}
                  >
                    {msgWithExtras.message_type === "image" ? (
                      <div className="text-xs italic opacity-70">[Image]</div>
                    ) : (
                      <p>{msg.content}</p>
                    )}
                    <div className="flex items-center gap-1 mt-1 opacity-60 flex-wrap">
                      <span className="text-[10px]">
                        {msg.created_at ? formatDateTime(msg.created_at) : ""}
                      </span>
                      {msg.model_used && (
                        <span className="text-[10px] px-1 bg-black/10 rounded">
                          {msg.model_used === "sonnet-4-6"
                            ? "S"
                            : msg.model_used === "haiku-4-5"
                              ? "H"
                              : "👤"}
                        </span>
                      )}
                      {isUser && msgWithExtras.intent && msgWithExtras.intent !== "other" && (
                        <IntentBadge intent={msgWithExtras.intent} />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* Manual reply */}
          {flags?.escalated_to_human && (
            <div className="px-4 py-3 border-t border-gray-100 flex gap-2">
              <input
                value={manualReply}
                onChange={(e) => setManualReply(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && !e.shiftKey && sendManualReply()
                }
                placeholder="Type a message..."
                className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <button
                type="button"
                onClick={sendManualReply}
                disabled={sending || !manualReply.trim()}
                className="px-4 py-2 bg-orange-500 text-white text-sm rounded-lg hover:bg-orange-600 disabled:opacity-50 transition-colors"
              >
                Send
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="hidden md:flex flex-1 items-center justify-center text-sm text-gray-400">
          Select a conversation
        </div>
      )}
    </div>
  );
}

function IntentBadge({ intent }: { intent: string }) {
  const colors: Record<string, string> = {
    faq: "bg-blue-100 text-blue-600",
    ordering: "bg-green-100 text-green-700",
    complaint: "bg-red-100 text-red-600",
    payment: "bg-purple-100 text-purple-700",
  };
  return (
    <span className={`text-[9px] px-1 rounded ${colors[intent] ?? "bg-gray-200 text-gray-600"}`}>
      {intent}
    </span>
  );
}
