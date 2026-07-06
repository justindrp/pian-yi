"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  filterThreads,
  type InboxFilter,
} from "@/components/dashboard/inbox-filters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  DeliveryScheduleSlot,
  ExtractedOrderReview,
} from "@/lib/claude/extract-order";
import { normalizeCustomerState } from "@/lib/customers/lifecycle";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime, maskPhone } from "@/lib/utils/format";
import type { Database } from "@/types/database";

type Conversation = Database["public"]["Tables"]["conversations"]["Row"];
type Customer = Database["public"]["Tables"]["customers"]["Row"];
const LEARNED_CONTEXT_START = "[AI learned context]";
const LEARNED_CONTEXT_END = "[/AI learned context]";

interface Thread {
  customer: Customer;
  lastMessage: Conversation;
  unread: boolean;
  menuShown: boolean;
  unanswered: boolean;
}

const PIPELINE_STAGES = [
  { value: "new", label: "New" },
  { value: "ordering", label: "Ordering" },
  { value: "lapsed", label: "Lapsed" },
  { value: "churned", label: "Churned" },
] as const;

type PipelineStage = (typeof PIPELINE_STAGES)[number]["value"];

function getInboxImageSrc(
  msg: Conversation & {
    message_type?: string | null;
    media_id?: string | null;
  },
) {
  if (msg.message_type !== "image") return null;
  if (msg.media_id) return `/api/inbox/media/${msg.media_id}`;
  if (!msg.content?.startsWith("https://")) return null;

  const deliveryProofPath = msg.content.split("/delivery-proofs/")[1];
  if (deliveryProofPath) {
    const encodedPath = deliveryProofPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `/api/inbox/delivery-proofs/${encodedPath}`;
  }

  return msg.content;
}

const URL_PATTERN = /(https?:\/\/\S+)/g;

function renderContentWithLinks(content: string | null | undefined) {
  if (!content) return content;
  const parts = content.split(URL_PATTERN);
  return parts.map((part, i) => {
    const isLink = part.startsWith("http://") || part.startsWith("https://");
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split of a single message, order never changes
      <span key={i}>
        {isLink ? (
          <a
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="underline break-all"
          >
            {part}
          </a>
        ) : (
          part
        )}
      </span>
    );
  });
}

function getReceiptLabel(status: string | null) {
  switch (status) {
    case "read":
      return "Read";
    case "delivered":
      return "Delivered";
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
    default:
      return null;
  }
}

function getReceiptClass(status: string | null) {
  switch (status) {
    case "read":
      return "text-emerald-100";
    case "delivered":
      return "text-orange-100";
    case "failed":
      return "text-red-100";
    default:
      return "text-orange-100";
  }
}

export default function InboxClient() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    null,
  );
  const [messages, setMessages] = useState<Conversation[]>([]);
  const [manualReply, setManualReply] = useState("");
  const [botReply, setBotReply] = useState("");
  const [botReplyPreview, setBotReplyPreview] = useState<string | null>(null);
  const [saveBotReplyAsRule, setSaveBotReplyAsRule] = useState(false);
  const [confirmingBotReply, setConfirmingBotReply] = useState(false);
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
  const [customerStage, setCustomerStage] = useState<PipelineStage>("new");
  const [stageDraft, setStageDraft] = useState<PipelineStage>("new");
  const [applyingStage, setApplyingStage] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateStatus, setRegenerateStatus] = useState<string | null>(null);
  const [extractingOrder, setExtractingOrder] = useState(false);
  const [extractOrderError, setExtractOrderError] = useState<string | null>(
    null,
  );
  const [extractedOrder, setExtractedOrder] =
    useState<ExtractedOrderReview | null>(null);
  const [confirmingExtractedOrder, setConfirmingExtractedOrder] =
    useState(false);
  const [
    sendingExtractedOrderPaymentInfo,
    setSendingExtractedOrderPaymentInfo,
  ] = useState(true);
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [learningContext, setLearningContext] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [learnedContextStatus, setLearnedContextStatus] = useState<
    string | null
  >(null);
  const [learnedContext, setLearnedContext] = useState<string | null>(null);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameQuery, setRenameQuery] = useState("");
  const [allCustomers, setAllCustomers] = useState<
    { id: string; name: string; phone_number: string }[]
  >([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const supabase = useMemo(() => createClient(), []);
  // Ref so the realtime callback always sees the latest value without re-subscribing
  const selectedCustomerIdRef = useRef<string | null>(null);
  const replayStateRef = useRef<{
    customerId: string | null;
    wasBlocked: boolean | null;
    attemptedForLatestUserMessage: boolean;
  }>({
    customerId: null,
    wasBlocked: null,
    attemptedForLatestUserMessage: false,
  });

  const loadThreads = useCallback(async () => {
    const { data } = await supabase
      .from("conversations")
      .select("*, customers!conversations_customer_id_fkey(*)")
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
        unanswered: false,
      });
    }

    if (grouped.length > 0) {
      const customerIds = grouped.map((t) => t.customer.id);
      const [{ data: stateData }, { data: flagData }] = await Promise.all([
        supabase
          .from("customer_state")
          .select("customer_id, menu_shown")
          .in("customer_id", customerIds),
        supabase
          .from("customer_flags")
          .select("customer_id, escalated_to_human, pending_bot_response")
          .in("customer_id", customerIds),
      ]);
      const menuShownMap = new Map(
        (stateData ?? []).map((s) => [s.customer_id, s.menu_shown ?? false]),
      );
      const unansweredMap = new Map(
        (flagData ?? []).map((flag) => [
          flag.customer_id,
          !!(flag.escalated_to_human || flag.pending_bot_response),
        ]),
      );
      for (const thread of grouped) {
        thread.menuShown = menuShownMap.get(thread.customer.id) ?? false;
        thread.unanswered = unansweredMap.get(thread.customer.id) ?? false;
      }
    }

    setThreads(grouped);
  }, [supabase]);

  const loadFlags = useCallback(
    async (customerId: string) => {
      const { data: flagData } = await supabase
        .from("customer_flags")
        .select(
          "escalated_to_human, pending_bot_response, pending_bot_question",
        )
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

  const loadLearnedContext = useCallback(
    async (customerId: string) => {
      const { data } = await supabase
        .from("customers")
        .select("notes")
        .eq("id", customerId)
        .single();
      setLearnedContext(extractLearnedContext(data?.notes ?? null));
    },
    [supabase],
  );

  const loadCustomerStage = useCallback(
    async (customerId: string) => {
      const { data } = await supabase
        .from("customer_state")
        .select("state")
        .eq("customer_id", customerId)
        .single();
      const stage = normalizeCustomerState(data?.state);
      setCustomerStage(stage);
      setStageDraft(stage);
    },
    [supabase],
  );

  // Keep the ref in sync with state
  useEffect(() => {
    selectedCustomerIdRef.current = selectedCustomerId;
  }, [selectedCustomerId]);

  useEffect(() => {
    const latestMessage = messages.at(-1) ?? null;
    const isBlocked = !!(
      flags?.pending_bot_response || flags?.escalated_to_human
    );

    if (!selectedCustomerId || !flags) {
      replayStateRef.current = {
        customerId: selectedCustomerId,
        wasBlocked: null,
        attemptedForLatestUserMessage: false,
      };
      return;
    }

    if (replayStateRef.current.customerId !== selectedCustomerId) {
      replayStateRef.current = {
        customerId: selectedCustomerId,
        wasBlocked: isBlocked,
        attemptedForLatestUserMessage: false,
      };
      return;
    }

    const shouldReplay =
      replayStateRef.current.wasBlocked === true &&
      !isBlocked &&
      latestMessage?.role === "user" &&
      !replayStateRef.current.attemptedForLatestUserMessage;

    replayStateRef.current.wasBlocked = isBlocked;

    if (!shouldReplay) {
      if (latestMessage?.role !== "user") {
        replayStateRef.current.attemptedForLatestUserMessage = false;
      }
      return;
    }

    replayStateRef.current.attemptedForLatestUserMessage = true;
    void fetch("/api/inbox/replay-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: selectedCustomerId }),
    }).then(() => loadMessages(selectedCustomerId));
  }, [flags, loadMessages, messages, selectedCustomerId]);

  useEffect(() => {
    if (!headerMenuOpen) return;

    const closeMenu = () => setHeaderMenuOpen(false);
    document.addEventListener("click", closeMenu);

    return () => document.removeEventListener("click", closeMenu);
  }, [headerMenuOpen]);

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

  // Scroll to bottom when switching threads; on message updates only if already near bottom
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional deps
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [selectedCustomerId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message change only
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function selectThread(customerId: string) {
    setSelectedCustomerId(customerId);
    setLearnedContextStatus(null);
    setLearnedContext(null);
    setMobileView("chat");
    await Promise.all([
      loadMessages(customerId),
      loadFlags(customerId),
      loadLearnedContext(customerId),
      loadCustomerStage(customerId),
    ]);
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
      body: JSON.stringify({
        customer_id: selectedCustomerId,
        escalated: newVal,
      }),
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
    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const question = lastCustomerMsg?.content ?? null;
    const prevFlags = flags;
    const nextFlags = {
      ...flags,
      pending_bot_response: true,
      pending_bot_question: question,
    };
    setFlags(nextFlags);
    const res = await fetch("/api/inbox/pending-bot-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: selectedCustomerId, question }),
    });
    if (!res.ok) {
      setFlags(prevFlags);
      return;
    }
    setFlags(nextFlags);
  }

  async function regenerateReply() {
    if (!selectedCustomerId || !flags) return;
    setRegenerating(true);
    setRegenerateStatus(null);
    if (flags.escalated_to_human || flags.pending_bot_response) {
      const takeoverRes = await fetch("/api/inbox/takeover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_id: selectedCustomerId,
          escalated: false,
        }),
      });
      if (!takeoverRes.ok) {
        setRegenerating(false);
        setRegenerateStatus("Failed to clear thread state");
        return;
      }
      setFlags({
        ...flags,
        escalated_to_human: false,
        pending_bot_response: false,
        pending_bot_question: null,
      });
    }
    const res = await fetch("/api/inbox/replay-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: selectedCustomerId }),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      replayed?: boolean;
      reason?: string;
    } | null;
    setRegenerating(false);
    if (!res.ok || !body?.ok) {
      setRegenerateStatus("Failed to regenerate reply");
      return;
    }
    if (!body.replayed) {
      setRegenerateStatus(`Not regenerated: ${body.reason ?? "unknown"}`);
      return;
    }
    await loadMessages(selectedCustomerId);
  }

  async function extractOrder() {
    if (!selectedCustomerId) return;
    setExtractingOrder(true);
    setExtractOrderError(null);
    const res = await fetch("/api/inbox/extract-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: selectedCustomerId }),
    });
    setExtractingOrder(false);
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      data?: ExtractedOrderReview;
      error?: string;
    } | null;
    if (!res.ok || !body?.ok || !body.data) {
      setExtractOrderError(body?.error ?? "Failed to extract order");
      return;
    }
    setExtractedOrder(body.data);
  }

  async function refreshExtractedOrderPricing(packageSize: number) {
    const res = await fetch("/api/inbox/extract-order/pricing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package_size: packageSize }),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      data?: { price_per_portion: number; total_price: number };
    } | null;
    if (!res.ok || !body?.ok || !body.data) return;
    setExtractedOrder((current) => {
      if (!current || current.package_size !== packageSize) return current;
      return { ...current, ...body.data };
    });
  }

  async function confirmExtractedOrder(sendPaymentInfo: boolean) {
    if (!selectedCustomerId || !extractedOrder) return;
    setSendingExtractedOrderPaymentInfo(sendPaymentInfo);
    setConfirmingExtractedOrder(true);
    const res = await fetch("/api/inbox/extract-order/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: selectedCustomerId,
        input: extractedOrder,
        send_payment_info: sendPaymentInfo,
      }),
    });
    setConfirmingExtractedOrder(false);
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
    } | null;
    if (!res.ok || !body?.ok) {
      setExtractOrderError(body?.error ?? "Failed to create order");
      return;
    }
    setExtractedOrder(null);
    await loadMessages(selectedCustomerId);
  }

  async function learnConversationContext() {
    if (!selectedCustomerId) return;
    setLearningContext(true);
    setLearnedContextStatus(null);
    const res = await fetch("/api/inbox/learn-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: selectedCustomerId }),
    });
    setLearningContext(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setLearnedContextStatus(body?.error ?? "Failed to learn context");
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      summary?: string;
    } | null;
    setLearnedContext(body?.summary ?? null);
    setLearnedContextStatus("Learned context saved");
  }

  async function openRename() {
    if (allCustomers.length === 0) {
      const { data } = await supabase
        .from("customers")
        .select("id, name, phone_number")
        .not("name", "is", null)
        .order("name");
      setAllCustomers(
        (data ?? []) as { id: string; name: string; phone_number: string }[],
      );
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

  async function previewBotReply() {
    if (!selectedCustomerId || !botReply.trim()) return;
    setSendingBotReply(true);
    const res = await fetch("/api/inbox/bot-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: selectedCustomerId,
        admin_answer: botReply.trim(),
        preview_only: true,
      }),
    });
    setSendingBotReply(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      alert(`Failed to generate preview: ${body?.error ?? res.statusText}`);
      return;
    }
    const body = (await res.json()) as { preview?: string };
    setBotReplyPreview(body.preview ?? botReply.trim());
  }

  async function confirmBotReply() {
    if (!selectedCustomerId || !botReplyPreview) return;
    setConfirmingBotReply(true);
    const res = await fetch("/api/inbox/bot-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: selectedCustomerId,
        polished_text: botReplyPreview,
        admin_answer: botReply.trim(),
        save_as_rule: saveBotReplyAsRule,
      }),
    });
    setConfirmingBotReply(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      alert(`Failed to send: ${body?.error ?? res.statusText}`);
      return;
    }
    setBotReply("");
    setBotReplyPreview(null);
    setSaveBotReplyAsRule(false);
    if (flags)
      setFlags({
        ...flags,
        pending_bot_response: false,
        pending_bot_question: null,
      });
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
      whatsapp_status: "sent",
      whatsapp_status_updated_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    const res = await fetch("/api/inbox/manual-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: selectedCustomerId, text }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
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

  useEffect(() => {
    if (!flags?.escalated_to_human) return;
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        setImageFile(file);
        setImagePreviewUrl(URL.createObjectURL(file));
        break;
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [flags?.escalated_to_human]);

  async function sendImage() {
    if (!selectedCustomerId || !imageFile) return;
    setSendingImage(true);
    const form = new FormData();
    form.append("customer_id", selectedCustomerId);
    form.append("file", imageFile);
    const res = await fetch("/api/inbox/manual-image", {
      method: "POST",
      body: form,
    });
    setSendingImage(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      alert(`Failed to send image: ${body?.error ?? res.statusText}`);
      return;
    }
    cancelImage();
    await loadMessages(selectedCustomerId);
  }

  async function applyPipelineStage() {
    if (!selectedCustomerId || applyingStage) return;
    setApplyingStage(true);
    const previousStage = customerStage;
    setCustomerStage(stageDraft);
    const res = await fetch("/api/inbox/pipeline-stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: selectedCustomerId,
        stage: stageDraft,
      }),
    });
    setApplyingStage(false);
    if (!res.ok) {
      setCustomerStage(previousStage);
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      alert(`Failed to update stage: ${body?.error ?? res.statusText}`);
      return;
    }
    await loadThreads();
  }

  const selectedThread = threads.find(
    (t) => t.customer.id === selectedCustomerId,
  );
  const filteredByTab = filterThreads(threads, inboxFilter);
  const query = searchQuery.trim().toLowerCase();
  const visibleThreads = query
    ? filteredByTab.filter(
        (t) =>
          t.customer.name?.toLowerCase().includes(query) ||
          t.customer.phone_number.toLowerCase().includes(query) ||
          t.lastMessage.content.toLowerCase().includes(query),
      )
    : filteredByTab;

  return (
    <div className="flex h-[calc(100vh-7rem)] bg-white rounded-xl border border-gray-100 overflow-hidden">
      {/* Thread list */}
      <div
        className={`w-full md:w-72 flex-shrink-0 border-r border-gray-100 overflow-y-auto ${mobileView === "chat" ? "hidden md:block" : "block"}`}
      >
        <div className="p-4 border-b border-gray-100">
          <h1 className="text-sm font-semibold text-gray-900">Inbox</h1>
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search chats..."
            className="mt-3 h-8 text-xs"
            aria-label="Search chats"
          />
          <div className="mt-3 flex gap-1 rounded-lg bg-gray-100 p-1">
            {(
              [
                ["all", "All"],
                ["unread", "Unread"],
                ["unanswered", "Unanswered"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setInboxFilter(value)}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                  inboxFilter === value
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {visibleThreads.map((thread) => (
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
                {thread.unanswered && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700">
                    unanswered
                  </span>
                )}
                <span
                  className={`text-[9px] px-1 py-0.5 rounded font-medium ${thread.menuShown ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}
                >
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
        {visibleThreads.length === 0 && (
          <p className="text-xs text-gray-400 p-4">
            {threads.length === 0
              ? "No conversations yet."
              : query
                ? "No conversations match this search."
                : "No conversations match this filter."}
          </p>
        )}
      </div>

      {/* Conversation detail */}
      {selectedThread ? (
        <div
          className={`flex-1 flex flex-col min-w-0 ${mobileView === "list" ? "hidden md:flex" : "flex"}`}
        >
          {/* Header */}
          <div className="px-5 py-3 border-b border-gray-100 flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              <button
                type="button"
                onClick={() => setMobileView("list")}
                className="md:hidden text-gray-500 text-lg leading-none pr-1 pt-0.5"
                aria-label="Back to list"
              >
                ‹
              </button>
              <div className="min-w-0 flex-1">
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
                              c.name
                                .toLowerCase()
                                .includes(renameQuery.toLowerCase()),
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
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          role="img"
                          aria-label="Rename customer"
                        >
                          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2 min-w-0 flex-wrap text-xs text-gray-400">
                  <p>{maskPhone(selectedThread.customer.phone_number)}</p>
                  <span className="text-gray-200">•</span>
                  <span
                    className={`px-1.5 py-0.5 rounded font-medium ${selectedThread.menuShown ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}
                  >
                    {selectedThread.menuShown
                      ? "menu images sent"
                      : "menu images not sent"}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded font-medium ${stageBadgeClass(customerStage)}`}
                  >
                    {customerStage.replace(/_/g, " ")}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <select
                  value={stageDraft}
                  onChange={(e) =>
                    setStageDraft(e.target.value as PipelineStage)
                  }
                  className="h-8 min-w-32 rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-700"
                  disabled={applyingStage}
                  aria-label="Pipeline stage"
                >
                  {PIPELINE_STAGES.map((stage) => (
                    <option key={stage.value} value={stage.value}>
                      {stage.label}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={applyPipelineStage}
                  disabled={applyingStage || stageDraft === customerStage}
                  className="border-violet-200 text-violet-700 hover:bg-violet-50"
                >
                  {applyingStage ? "Applying..." : "Save stage"}
                </Button>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={toggleEscalation}
                className={
                  flags?.escalated_to_human
                    ? "bg-green-600 text-white hover:bg-green-700"
                    : "bg-orange-500 text-white hover:bg-orange-600"
                }
              >
                {flags?.escalated_to_human ? "Resume bot" : "Take over"}
              </Button>
              <div className="relative">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setHeaderMenuOpen((open) => !open);
                  }}
                  aria-expanded={headerMenuOpen}
                  aria-haspopup="menu"
                >
                  More
                </Button>
                {headerMenuOpen ? (
                  <div className="absolute right-0 top-full z-20 mt-2 w-44 rounded-md border border-gray-200 bg-white p-1 shadow-lg">
                    <button
                      type="button"
                      className="flex w-full items-center rounded-sm px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        void learnConversationContext();
                      }}
                      disabled={learningContext}
                    >
                      {learningContext ? "Learning..." : "Learn chat"}
                    </button>
                    {!flags?.pending_bot_response &&
                    !flags?.escalated_to_human ? (
                      <button
                        type="button"
                        className="flex w-full items-center rounded-sm px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => {
                          setHeaderMenuOpen(false);
                          void activateBotWaiting();
                        }}
                      >
                        Guide bot
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="flex w-full items-center rounded-sm px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        void regenerateReply();
                      }}
                      disabled={regenerating}
                    >
                      {regenerating ? "Regenerating..." : "Regenerate reply"}
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center rounded-sm px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        void extractOrder();
                      }}
                      disabled={extractingOrder}
                    >
                      {extractingOrder ? "Extracting..." : "Extract order"}
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center rounded-sm px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        setDeleteConfirmOpen(true);
                      }}
                    >
                      Delete customer
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {learnedContextStatus && (
            <div className="px-5 py-2 border-b border-blue-100 bg-blue-50 text-xs text-blue-700">
              {learnedContextStatus}
            </div>
          )}

          {regenerateStatus && (
            <div className="px-5 py-2 border-b border-blue-100 bg-blue-50 text-xs text-blue-700">
              {regenerateStatus}
            </div>
          )}

          {extractOrderError && (
            <div className="px-5 py-2 border-b border-red-100 bg-red-50 text-xs text-red-700">
              {extractOrderError}
            </div>
          )}

          {learnedContext && (
            <div className="border-b border-blue-100 bg-blue-50">
              <button
                type="button"
                onClick={() => setContextCollapsed((c) => !c)}
                className="w-full flex items-center justify-between px-5 py-2 text-xs font-medium text-blue-900 hover:bg-blue-100 transition-colors"
              >
                <span>Customer context</span>
                <span>{contextCollapsed ? "▼" : "▲"}</span>
              </button>
              {!contextCollapsed && (
                <div className="px-5 pb-3">
                  <p className="text-xs text-blue-800 whitespace-pre-wrap leading-relaxed">
                    {learnedContext}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Messages */}
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto p-4 space-y-2"
          >
            {messages.map((msg) => {
              const isUser = msg.role === "user";
              const msgWithExtras = msg as Conversation & {
                intent?: string | null;
                message_type?: string | null;
                media_id?: string | null;
                whatsapp_status?: string | null;
              };
              const imageSrc = getInboxImageSrc(msgWithExtras);
              const receiptLabel = !isUser
                ? getReceiptLabel(msgWithExtras.whatsapp_status ?? null)
                : null;
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
                      imageSrc ? (
                        // biome-ignore lint/performance/noImgElement: media served via API route — next/image impractical
                        <img
                          src={imageSrc}
                          alt="Media"
                          className="max-w-full rounded-lg"
                          style={{ maxHeight: 300 }}
                        />
                      ) : (
                        <div className="text-xs italic opacity-70">[Image]</div>
                      )
                    ) : (
                      <p className="whitespace-pre-wrap">
                        {renderContentWithLinks(msg.content)}
                      </p>
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
                      {isUser &&
                        msgWithExtras.intent &&
                        msgWithExtras.intent !== "other" && (
                          <IntentBadge intent={msgWithExtras.intent} />
                        )}
                      {!isUser && receiptLabel && (
                        <span
                          className={`text-[10px] ${getReceiptClass(
                            msgWithExtras.whatsapp_status ?? null,
                          )}`}
                        >
                          {receiptLabel}
                        </span>
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
                  <p className="text-xs font-medium text-amber-800">
                    Bot is waiting for your answer
                  </p>
                  {flags.pending_bot_question && (
                    <p className="text-xs text-amber-700 mt-0.5 italic">
                      "{flags.pending_bot_question}"
                    </p>
                  )}
                </div>
              </div>
              {botReplyPreview ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-amber-800">
                    AI will send this:
                  </p>
                  <p className="text-sm text-amber-900 bg-white border border-amber-200 rounded-lg px-3 py-2 whitespace-pre-wrap">
                    {botReplyPreview}
                  </p>
                  <label className="flex items-center gap-2 text-xs text-amber-800">
                    <input
                      type="checkbox"
                      checked={saveBotReplyAsRule}
                      onChange={(e) => setSaveBotReplyAsRule(e.target.checked)}
                    />
                    Save as permanent bot rule (applies to all future customers)
                  </label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      onClick={confirmBotReply}
                      disabled={confirmingBotReply}
                      className="bg-amber-500 text-white hover:bg-amber-600"
                    >
                      {confirmingBotReply ? "Sending..." : "Send"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setBotReplyPreview(null);
                        setSaveBotReplyAsRule(false);
                      }}
                      disabled={confirmingBotReply}
                      className="border-amber-200 text-amber-700 hover:bg-amber-100"
                    >
                      Edit
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Textarea
                    value={botReply}
                    onChange={(e) => setBotReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void previewBotReply();
                      }
                    }}
                    placeholder="Type your answer (AI will polish it)..."
                    rows={3}
                    className="flex-1 min-h-0 resize-none border-amber-200 focus-visible:ring-amber-400"
                  />
                  <Button
                    type="button"
                    onClick={previewBotReply}
                    disabled={sendingBotReply || !botReply.trim()}
                    className="bg-amber-500 text-white hover:bg-amber-600"
                  >
                    {sendingBotReply ? "Previewing..." : "Preview"}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Manual reply */}
          {flags?.escalated_to_human && (
            <div className="border-t border-gray-100">
              {imagePreviewUrl && (
                <div className="px-4 pt-3 pb-2 flex items-start gap-3 bg-gray-50">
                  {/* biome-ignore lint/performance/noImgElement: local object URL preview — next/image impractical */}
                  <img
                    src={imagePreviewUrl}
                    alt="Preview"
                    className="h-20 w-20 object-cover rounded-lg border border-gray-200 flex-shrink-0"
                  />
                  <div className="flex flex-col gap-2 min-w-0 flex-1">
                    <p className="text-xs text-gray-500 truncate">
                      {imageFile?.name}
                    </p>
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
                <Textarea
                  value={manualReply}
                  onChange={(e) => setManualReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void sendManualReply();
                    }
                  }}
                  placeholder="Type a message..."
                  rows={3}
                  className="flex-1 min-h-0 resize-none"
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

      {extractedOrder && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5 max-h-[90vh] overflow-y-auto">
            <h2 className="text-sm font-semibold text-gray-900 mb-1">
              Review extracted order
            </h2>
            <p className="text-xs text-gray-600 mb-4">
              Parsed from this conversation. Fix anything wrong before creating
              the order — this will send the payment-details message to the
              customer.
            </p>
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="extract-name"
                  className="text-xs font-medium text-gray-700"
                >
                  Nama
                </label>
                <Input
                  id="extract-name"
                  value={extractedOrder.customer_name}
                  onChange={(e) =>
                    setExtractedOrder({
                      ...extractedOrder,
                      customer_name: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <label
                  htmlFor="extract-address"
                  className="text-xs font-medium text-gray-700"
                >
                  Alamat
                </label>
                <Textarea
                  id="extract-address"
                  value={extractedOrder.address}
                  onChange={(e) =>
                    setExtractedOrder({
                      ...extractedOrder,
                      address: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <label
                  htmlFor="extract-maps-link"
                  className="text-xs font-medium text-gray-700"
                >
                  Maps link
                </label>
                <Input
                  id="extract-maps-link"
                  value={extractedOrder.maps_link}
                  onChange={(e) =>
                    setExtractedOrder({
                      ...extractedOrder,
                      maps_link: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <label
                  htmlFor="extract-area"
                  className="text-xs font-medium text-gray-700"
                >
                  Area
                </label>
                <Input
                  id="extract-area"
                  value={extractedOrder.area}
                  onChange={(e) =>
                    setExtractedOrder({
                      ...extractedOrder,
                      area: e.target.value,
                    })
                  }
                />
              </div>
              {(() => {
                const o = extractedOrder as ExtractedOrderReview;
                const scheduleMode = (o.delivery_schedule?.length ?? 0) > 0;

                function toggleScheduleMode() {
                  if (scheduleMode) {
                    setExtractedOrder({ ...o, delivery_schedule: [] });
                    return;
                  }
                  const defaultPortions = o.portions_per_delivery || 1;
                  const slots: DeliveryScheduleSlot[] = [];
                  if (o.start_date && o.end_date) {
                    const cur = new Date(o.start_date);
                    const last = new Date(o.end_date);
                    while (cur <= last) {
                      const dow = cur.getDay();
                      if (dow !== 0 && dow !== 6) {
                        slots.push({
                          date: cur.toISOString().slice(0, 10),
                          meal_type: "lunch",
                          portions: defaultPortions,
                        });
                      }
                      cur.setDate(cur.getDate() + 1);
                    }
                  }
                  if (slots.length === 0) {
                    slots.push({
                      date: o.start_date ?? new Date().toISOString().slice(0, 10),
                      meal_type: "lunch",
                      portions: defaultPortions,
                    });
                  }
                  const newTotal = slots.reduce((s, r) => s + r.portions, 0);
                  setExtractedOrder({
                    ...o,
                    delivery_schedule: slots,
                    package_size: newTotal,
                  });
                  void refreshExtractedOrderPricing(newTotal);
                }

                function updateScheduleRow(
                  idx: number,
                  patch: Partial<DeliveryScheduleSlot>,
                ) {
                  const rows = [...(o.delivery_schedule ?? [])];
                  rows[idx] = { ...rows[idx], ...patch };
                  const newTotal = rows.reduce((s, r) => s + r.portions, 0);
                  setExtractedOrder({ ...o, delivery_schedule: rows, package_size: newTotal });
                  if (patch.portions !== undefined) {
                    void refreshExtractedOrderPricing(newTotal);
                  }
                }

                function removeScheduleRow(idx: number) {
                  const rows = (o.delivery_schedule ?? []).filter((_, i) => i !== idx);
                  const newTotal = rows.reduce((s, r) => s + r.portions, 0);
                  setExtractedOrder({ ...o, delivery_schedule: rows, package_size: newTotal });
                  void refreshExtractedOrderPricing(newTotal);
                }

                function addScheduleRow() {
                  const rows = o.delivery_schedule ?? [];
                  const lastDate =
                    rows[rows.length - 1]?.date ??
                    new Date().toISOString().slice(0, 10);
                  const next = new Date(lastDate);
                  next.setDate(next.getDate() + 1);
                  while (next.getDay() === 0 || next.getDay() === 6) {
                    next.setDate(next.getDate() + 1);
                  }
                  const newRows = [
                    ...rows,
                    {
                      date: next.toISOString().slice(0, 10),
                      meal_type: "lunch",
                      portions: o.portions_per_delivery || 1,
                    },
                  ];
                  const newTotal = newRows.reduce((s, r) => s + r.portions, 0);
                  setExtractedOrder({ ...o, delivery_schedule: newRows, package_size: newTotal });
                  void refreshExtractedOrderPricing(newTotal);
                }

                return (
                  <>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-700">
                        {scheduleMode ? "Package size (porsi)" : "Porsi"}
                      </span>
                      <div className="flex gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => scheduleMode && toggleScheduleMode()}
                          className={!scheduleMode ? "text-blue-600 font-semibold" : "text-gray-400 hover:text-gray-600"}
                        >
                          Seragam
                        </button>
                        <span className="text-gray-300">|</span>
                        <button
                          type="button"
                          onClick={() => !scheduleMode && toggleScheduleMode()}
                          className={scheduleMode ? "text-blue-600 font-semibold" : "text-gray-400 hover:text-gray-600"}
                        >
                          Per hari
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Input
                          id="extract-package-size"
                          type="number"
                          value={o.package_size}
                          readOnly={scheduleMode}
                          className={scheduleMode ? "bg-gray-50" : ""}
                          onChange={(e) => {
                            if (scheduleMode) return;
                            const packageSize = Number(e.target.value);
                            setExtractedOrder({
                              ...o,
                              package_size: packageSize,
                              ...(Number.isFinite(packageSize) && packageSize > 0
                                ? {}
                                : { price_per_portion: 0, total_price: 0 }),
                            });
                            if (Number.isFinite(packageSize) && packageSize > 0) {
                              void refreshExtractedOrderPricing(packageSize);
                            }
                          }}
                        />
                      </div>
                      {!scheduleMode && (
                        <div>
                          <Input
                            id="extract-portions-per-delivery"
                            type="number"
                            value={o.portions_per_delivery}
                            onChange={(e) =>
                              setExtractedOrder({
                                ...o,
                                portions_per_delivery: Number(e.target.value),
                              })
                            }
                          />
                        </div>
                      )}
                    </div>
                    {scheduleMode && (
                      <div className="space-y-1">
                        {(o.delivery_schedule ?? []).map((slot, idx) => (
                          <div
                            key={`${slot.date}-${idx}`}
                            className="flex gap-1 items-center"
                          >
                            <Input
                              type="date"
                              value={slot.date}
                              className="text-xs h-8 flex-1"
                              onChange={(e) =>
                                updateScheduleRow(idx, { date: e.target.value })
                              }
                            />
                            <select
                              value={slot.meal_type}
                              onChange={(e) =>
                                updateScheduleRow(idx, { meal_type: e.target.value })
                              }
                              className="text-xs h-8 border rounded px-1 bg-white"
                            >
                              <option value="lunch">Siang</option>
                              <option value="dinner">Malam</option>
                            </select>
                            <Input
                              type="number"
                              value={slot.portions}
                              min={1}
                              className="text-xs h-8 w-14"
                              onChange={(e) =>
                                updateScheduleRow(idx, { portions: Number(e.target.value) })
                              }
                            />
                            <button
                              type="button"
                              onClick={() => removeScheduleRow(idx)}
                              className="text-gray-400 hover:text-red-500 text-sm px-1"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={addScheduleRow}
                          className="text-xs text-blue-600 hover:underline mt-1"
                        >
                          + Tambah hari
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="extract-price-per-portion"
                    className="text-xs font-medium text-gray-700"
                  >
                    Harga/porsi
                  </label>
                  <Input
                    id="extract-price-per-portion"
                    value={`Rp ${extractedOrder.price_per_portion.toLocaleString("id-ID")}`}
                    readOnly
                    className="bg-gray-50"
                  />
                </div>
                <div>
                  <label
                    htmlFor="extract-total-price"
                    className="text-xs font-medium text-gray-700"
                  >
                    Total harga
                  </label>
                  <Input
                    id="extract-total-price"
                    value={`Rp ${extractedOrder.total_price.toLocaleString("id-ID")}`}
                    readOnly
                    className="bg-gray-50"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="extract-start-date"
                    className="text-xs font-medium text-gray-700"
                  >
                    Tanggal mulai
                  </label>
                  <Input
                    id="extract-start-date"
                    type="date"
                    value={extractedOrder.start_date ?? ""}
                    onChange={(e) =>
                      setExtractedOrder({
                        ...extractedOrder,
                        start_date: e.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <label
                    htmlFor="extract-end-date"
                    className="text-xs font-medium text-gray-700"
                  >
                    Tanggal selesai
                  </label>
                  <Input
                    id="extract-end-date"
                    type="date"
                    value={extractedOrder.end_date ?? ""}
                    onChange={(e) =>
                      setExtractedOrder({
                        ...extractedOrder,
                        end_date: e.target.value,
                      })
                    }
                  />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setExtractedOrder(null)}
                disabled={confirmingExtractedOrder}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => confirmExtractedOrder(false)}
                disabled={confirmingExtractedOrder}
              >
                {confirmingExtractedOrder && !sendingExtractedOrderPaymentInfo
                  ? "Creating..."
                  : "Create order only"}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => confirmExtractedOrder(true)}
                disabled={confirmingExtractedOrder}
              >
                {confirmingExtractedOrder && sendingExtractedOrderPaymentInfo
                  ? "Creating..."
                  : "Create order & send payment info"}
              </Button>
            </div>
          </div>
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

function extractLearnedContext(notes: string | null): string | null {
  if (!notes) return null;
  const start = notes.indexOf(LEARNED_CONTEXT_START);
  const end = notes.indexOf(LEARNED_CONTEXT_END);
  if (start === -1 || end === -1 || end <= start) return null;
  const content = notes.slice(start + LEARNED_CONTEXT_START.length, end).trim();
  return content || null;
}

function IntentBadge({ intent }: { intent: string }) {
  const colors: Record<string, string> = {
    faq: "bg-blue-100 text-blue-600",
    ordering: "bg-green-100 text-green-700",
    complaint: "bg-red-100 text-red-600",
    payment: "bg-purple-100 text-purple-700",
  };
  return (
    <span
      className={`text-[9px] px-1 rounded ${colors[intent] ?? "bg-gray-200 text-gray-600"}`}
    >
      {intent}
    </span>
  );
}

function stageBadgeClass(stage: string) {
  const colors: Record<string, string> = {
    new: "bg-gray-100 text-gray-600",
    ordering: "bg-yellow-50 text-yellow-700",
    lapsed: "bg-red-50 text-red-600",
    churned: "bg-red-100 text-red-700",
  };
  return colors[stage] ?? "bg-gray-100 text-gray-600";
}
