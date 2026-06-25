"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const [botReply, setBotReply] = useState("");
  const [sending, setSending] = useState(false);
  const [sendingBotReply, setSendingBotReply] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [sendingImage, setSendingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [flags, setFlags] = useState<{
    escalated_to_human: boolean;
    pending_bot_response: boolean;
    pending_bot_question: string | null;
  } | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameQuery, setRenameQuery] = useState("");
  const [allCustomers, setAllCustomers] = useState<
    { id: string; name: string; phone_number: string }[]
  >([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
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

  const loadFlags = useCallback(
    async (customerId: string) => {
      const { data: flagData } = await supabase
        .from("customer_flags")
        .select("escalated_to_human, pending_bot_response, pending_bot_question")
        .eq("customer_id", customerId)
        .single();
      setFlags(
        flagData
          ? {
              escalated_to_human: flagData.escalated_to_human ?? false,
              pending_bot_response: flagData.pending_bot_response ?? false,
              pending_bot_question: flagData.pending_bot_question ?? null,
            }
          : null,
      );
    },
    [supabase],
  );

  const loadMessages = useCallback(
    async (customerId: string) => {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: true });
      setMessages(data ?? []);
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

    const refresh = () => {
      void loadThreads();
      const current = selectedCustomerIdRef.current;
      if (current) void loadMessages(current);
    };

    const channel = supabase
      .channel("conversations-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "conversations" },
        refresh,
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "customers" },
        () => void loadThreads(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "customer_flags" },
        () => {
          const current = selectedCustomerIdRef.current;
          if (current) void loadFlags(current);
        },
      )
      .subscribe();

    // Polling fallback — Railway's reverse proxy occasionally drops the
    // realtime websocket; this guarantees new messages appear within 10s
    // even if the socket is dead.
    const pollInterval = setInterval(refresh, 10_000);

    // Refresh immediately when the tab regains focus
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      void supabase.removeChannel(channel);
      clearInterval(pollInterval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadThreads, loadMessages, loadFlags, supabase]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message change only
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function selectThread(customerId: string) {
    setSelectedCustomerId(customerId);
    setMobileView("chat");
    await Promise.all([loadMessages(customerId), loadFlags(customerId)]);
  }

  async function toggleEscalation() {
    if (!selectedCustomerId || !flags) return;
    const newVal = !flags.escalated_to_human;
    const prevFlags = flags;
    const nextFlags = { ...flags, escalated_to_human: newVal };
    setFlags(nextFlags); // optimistic — show input immediately
    const res = await fetch("/api/inbox/takeover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: selectedCustomerId, escalated: newVal }),
    });
    if (!res.ok) {
      setFlags(prevFlags);
      return;
    }
    // Re-apply in case a concurrent loadMessages() overwrote optimistic state during the await
    setFlags(nextFlags);
  }

  async function activateBotWaiting() {
    if (!selectedCustomerId || !flags) return;
    const prevFlags = flags;
    const nextFlags = { ...flags, pending_bot_response: true, pending_bot_question: null };
    setFlags(nextFlags);
    const res = await fetch("/api/inbox/pending-bot-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: selectedCustomerId }),
    });
    if (!res.ok) {
      setFlags(prevFlags);
      return;
    }
    setFlags(nextFlags);
  }

  async function openRename() {
    if (allCustomers.length === 0) {
      const { data } = await supabase
        .from("customers")
        .select("id, name, phone_number")
        .not("name", "is", null)
        .order("name");
      setAllCustomers((data ?? []) as { id: string; name: string; phone_number: string }[]);
    }
    setRenameQuery("");
    setRenaming(true);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }

  async function submitRename(name: string) {
    if (!selectedCustomerId || !name.trim()) return;
    setRenaming(false);
    setThreads((prev) =>
      prev.map((t) =>
        t.customer.id === selectedCustomerId
          ? { ...t, customer: { ...t.customer, name } }
          : t,
      ),
    );
    await fetch(`/api/customers/${selectedCustomerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }

  async function sendBotReply() {
    if (!selectedCustomerId || !botReply.trim()) return;
    setSendingBotReply(true);
    const res = await fetch("/api/inbox/bot-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: selectedCustomerId, admin_answer: botReply.trim() }),
    });
    setSendingBotReply(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      alert(`Failed to send: ${body?.error ?? res.statusText}`);
      return;
    }
    setBotReply("");
    if (flags) setFlags({ ...flags, pending_bot_response: false, pending_bot_question: null });
    await loadMessages(selectedCustomerId);
  }

  async function deleteCustomer() {
    if (!selectedCustomerId) return;
    setDeleting(true);
    const res = await fetch(`/api/customers/${selectedCustomerId}`, {
      method: "DELETE",
    });
    setDeleting(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      alert(`Delete failed: ${body?.error ?? res.statusText}`);
      return;
    }
    setDeleteConfirmOpen(false);
    setSelectedCustomerId(null);
    setMessages([]);
    setFlags(null);
    setMobileView("list");
    await loadThreads();
  }

  async function sendManualReply() {
    if (!selectedCustomerId || !manualReply.trim()) return;
    setSending(true);

    const thread = threads.find((t) => t.customer.id === selectedCustomerId);
    if (!thread) {
      setSending(false);
      return;
    }

    const text = manualReply.trim();
    setManualReply("");

    // Optimistic update so the message appears immediately
    const optimistic: Conversation = {
      id: `optimistic-${Date.now()}`,
      customer_id: selectedCustomerId,
      role: "assistant",
      content: text,
      model_used: "human",
      created_at: new Date().toISOString(),
      intent: null,
      message_type: null,
      message_id: null,
      media_id: null,
      input_tokens: null,
      output_tokens: null,
    };
    setMessages((prev) => [...prev, optimistic]);

    const res = await fetch("/api/inbox/manual-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: selectedCustomerId, text }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      alert(`Failed to send: ${body?.error ?? res.statusText}`);
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setSending(false);
      return;
    }

    await loadMessages(selectedCustomerId);
    setSending(false);
  }

  function pickImage() {
    imageInputRef.current?.click();
  }

  function onImagePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreviewUrl(URL.createObjectURL(file));
    // reset so same file can be picked again
    e.target.value = "";
  }

  function cancelImage() {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(null);
    setImagePreviewUrl(null);
  }

  async function sendImage() {
    if (!selectedCustomerId || !imageFile) return;
    setSendingImage(true);
    const form = new FormData();
    form.append("customer_id", selectedCustomerId);
    form.append("file", imageFile);
    const res = await fetch("/api/inbox/manual-image", { method: "POST", body: form });
    setSendingImage(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      alert(`Failed to send image: ${body?.error ?? res.statusText}`);
      return;
    }
    cancelImage();
    await loadMessages(selectedCustomerId);
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
                  {renaming ? (
                    <div className="relative">
                      <Input
                        ref={renameInputRef}
                        value={renameQuery}
                        onChange={(e) => setRenameQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitRename(renameQuery);
                          if (e.key === "Escape") setRenaming(false);
                        }}
                        onBlur={() => setTimeout(() => setRenaming(false), 150)}
                        className="h-6 text-sm w-44 px-2 py-0"
                        placeholder="Type a name…"
                      />
                      {(() => {
                        const results = renameQuery.trim()
                          ? allCustomers.filter((c) =>
                              c.name.toLowerCase().includes(renameQuery.toLowerCase()),
                            )
                          : allCustomers;
                        return results.length > 0 ? (
                          <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded shadow-md w-64 max-h-48 overflow-y-auto">
                            {results.slice(0, 20).map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 flex items-center justify-between gap-2"
                                onMouseDown={() => submitRename(c.name)}
                              >
                                <span>{c.name}</span>
                                <span className="text-xs text-gray-400 shrink-0">
                                  {maskPhone(c.phone_number)}
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : null;
                      })()}
                    </div>
                  ) : (
                    <>
                      <p className="text-sm font-medium text-gray-900">
                        {selectedThread.customer.name ??
                          selectedThread.customer.phone_number}
                      </p>
                      <button
                        type="button"
                        onClick={openRename}
                        className="text-gray-300 hover:text-gray-500 flex-shrink-0"
                        aria-label="Rename customer"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                        </svg>
                      </button>
                    </>
                  )}
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${selectedThread.menuShown ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                    {selectedThread.menuShown ? "menu images sent ✓" : "menu images not sent"}
                  </span>
                </div>
                <p className="text-xs text-gray-400">
                  {maskPhone(selectedThread.customer.phone_number)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!flags?.pending_bot_response && !flags?.escalated_to_human && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={activateBotWaiting}
                  className="border-amber-200 text-amber-700 hover:bg-amber-50"
                >
                  Guide bot
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={toggleEscalation}
                className={flags?.escalated_to_human ? "border-green-200 text-green-700 hover:bg-green-100" : "border-orange-200 text-orange-700 hover:bg-orange-100"}
              >
                {flags?.escalated_to_human ? "Resume bot" : "Take over"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDeleteConfirmOpen(true)}
                aria-label="Delete customer"
                title="Delete customer and chat history"
                className="border-red-200 text-red-600 hover:bg-red-50"
              >
                Delete
              </Button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {messages.map((msg) => {
              const isUser = msg.role === "user";
              const msgWithExtras = msg as Conversation & { intent?: string | null; message_type?: string | null; media_id?: string | null };
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
                      <>
                        {msgWithExtras.media_id ? (
                          <img
                            src={`/api/inbox/media/${msgWithExtras.media_id}`}
                            alt="Image"
                            className="max-w-full rounded-lg"
                            style={{ maxHeight: 300 }}
                          />
                        ) : msg.content?.startsWith("https://") ? (
                          <img
                            src={msg.content}
                            alt="Image"
                            className="max-w-full rounded-lg"
                            style={{ maxHeight: 300 }}
                          />
                        ) : (
                          <div className="text-xs italic opacity-70">[Image]</div>
                        )}
                      </>
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

          {/* Bot-help reply panel */}
          {flags?.pending_bot_response && !flags.escalated_to_human && (
            <div className="px-4 py-3 border-t border-amber-200 bg-amber-50 space-y-2">
              <div className="flex items-start gap-2">
                <span className="text-amber-600 text-sm mt-0.5">⏳</span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-amber-800">Bot is waiting for your answer</p>
                  {flags.pending_bot_question && (
                    <p className="text-xs text-amber-700 mt-0.5 italic">"{flags.pending_bot_question}"</p>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  value={botReply}
                  onChange={(e) => setBotReply(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendBotReply()}
                  placeholder="Type your answer (AI will polish it)..."
                  className="flex-1 border-amber-200 focus-visible:ring-amber-400"
                />
                <Button
                  type="button"
                  onClick={sendBotReply}
                  disabled={sendingBotReply || !botReply.trim()}
                  className="bg-amber-500 text-white hover:bg-amber-600"
                >
                  {sendingBotReply ? "Sending..." : "Send"}
                </Button>
              </div>
            </div>
          )}

          {/* Manual reply */}
          {flags?.escalated_to_human && (
            <div className="border-t border-gray-100">
              {imagePreviewUrl && (
                <div className="px-4 pt-3 pb-2 flex items-start gap-3 bg-gray-50">
                  <img
                    src={imagePreviewUrl}
                    alt="Preview"
                    className="h-20 w-20 object-cover rounded-lg border border-gray-200 flex-shrink-0"
                  />
                  <div className="flex flex-col gap-2 min-w-0 flex-1">
                    <p className="text-xs text-gray-500 truncate">{imageFile?.name}</p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={sendImage}
                        disabled={sendingImage}
                        className="bg-orange-500 text-white hover:bg-orange-600"
                      >
                        {sendingImage ? "Sending..." : "Send image"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={cancelImage}
                        disabled={sendingImage}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </div>
              )}
              <div className="px-4 py-3 flex gap-2">
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onImagePicked}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={pickImage}
                  title="Attach image"
                  className="px-2.5 text-gray-500"
                >
                  📎
                </Button>
                <Input
                  value={manualReply}
                  onChange={(e) => setManualReply(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && !e.shiftKey && sendManualReply()
                  }
                  placeholder="Type a message..."
                  className="flex-1"
                />
                <Button
                  type="button"
                  onClick={sendManualReply}
                  disabled={sending || !manualReply.trim()}
                  className="bg-orange-500 text-white hover:bg-orange-600"
                >
                  Send
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="hidden md:flex flex-1 items-center justify-center text-sm text-gray-400">
          Select a conversation
        </div>
      )}

      {deleteConfirmOpen && selectedThread && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">
              Delete customer?
            </h2>
            <p className="text-xs text-gray-600 mb-4">
              This will permanently delete{" "}
              <span className="font-medium text-gray-900">
                {selectedThread.customer.name ??
                  selectedThread.customer.phone_number}
              </span>
              , along with all their chat history, orders, and scheduled
              deliveries. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDeleteConfirmOpen(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={deleteCustomer}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete permanently"}
              </Button>
            </div>
          </div>
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
