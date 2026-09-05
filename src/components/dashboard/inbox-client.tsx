"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  filterThreads,
  type InboxFilter,
} from "@/components/dashboard/inbox-filters";
import {
  getInboxDocument,
  getInboxDocumentCaption,
  getStoragePath,
} from "@/components/dashboard/inbox-media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  DeliveryScheduleSlot,
  ExtractedOrderReview,
} from "@/lib/claude/extract-order";
import { modelRole } from "@/lib/claude/model-tag";
import { normalizeCustomerState } from "@/lib/customers/lifecycle";
import {
  HOLD_CHOICES_MINUTES,
  TAKEOVER_INACTIVITY_MINUTES,
} from "@/lib/customers/takeover";
import { createClient } from "@/lib/supabase/client";
import {
  formatDateTime,
  formatThreadTime,
  maskPhone,
} from "@/lib/utils/format";
import type { Database } from "@/types/database";

type Conversation = Database["public"]["Tables"]["conversations"]["Row"];
type Customer = Database["public"]["Tables"]["customers"]["Row"];
const LEARNED_CONTEXT_START = "[AI learned context]";
const LEARNED_CONTEXT_END = "[/AI learned context]";

// The thread list draws a name, a phone number, 60 characters of the newest
// message and its time — so it selects those columns and nothing else. Both
// queries used to be select('*') and ran every 10 seconds per open tab, which
// is what pushed the Supabase project past its egress quota.
type ThreadCustomer = Pick<Customer, "id" | "name" | "phone_number">;
type ThreadMessage = Pick<
  Conversation,
  "customer_id" | "role" | "content" | "created_at"
>;

interface Thread {
  customer: ThreadCustomer;
  lastMessage: ThreadMessage;
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
    media_url?: string | null;
  },
) {
  if (msg.message_type !== "image") return null;

  // A stored copy wins over media_id: Meta deletes inbound media after about a
  // week, so the proxy 404s for anything older. The webhook writes media_url at
  // receipt time; rows backfilled by scripts/backfill-chat-media.ts predate that
  // column and hold the bucket URL in content instead.
  const storedPath =
    getStoragePath(msg.media_url, "chat-media") ??
    getStoragePath(msg.content, "chat-media");
  if (storedPath) return `/api/inbox/chat-media/${storedPath}`;

  if (msg.media_id) return `/api/inbox/media/${msg.media_id}`;

  // media_url first, then content: an outbound image whose caption is its
  // content keeps the file URL in media_url, and both older rows and the menu
  // sends still carry the URL as content.
  for (const candidate of [msg.media_url, msg.content]) {
    if (!candidate?.startsWith("https://")) continue;
    const deliveryProofPath = getStoragePath(candidate, "delivery-proofs");
    if (deliveryProofPath) {
      return `/api/inbox/delivery-proofs/${deliveryProofPath}`;
    }
    return candidate;
  }
  return null;
}

// The text sent alongside an image. Only a content that is not itself the file
// URL is a caption — every outbound image used to store the URL there, so the
// caption existed only in Meta's copy of the message: an apology for a late
// delivery was on the customer's phone and nowhere in the inbox.
function getInboxImageCaption(
  msg: Conversation & { message_type?: string | null },
) {
  if (msg.message_type !== "image") return null;
  const text = msg.content?.trim();
  if (!text || text.startsWith("https://") || text === "[Image]") return null;
  return text;
}

// Rows saved before the webhook stored media (migration 060) carry only a
// media_id, and Meta deletes inbound media after about a week — the proxy 404s
// and the browser shows a broken-image icon with no explanation. Swap in a
// caption so the gap reads as expired media rather than a bug.
function InboxImage({ src }: { src: string }) {
  const [expired, setExpired] = useState(false);

  if (expired) {
    return (
      <div className="text-xs italic opacity-70">
        Photo expired — no longer available from WhatsApp
      </div>
    );
  }

  return (
    // biome-ignore lint/performance/noImgElement: media served via API route — next/image impractical
    <img
      src={src}
      alt="Media"
      className="max-w-full rounded-lg"
      style={{ maxHeight: 300 }}
      onError={() => setExpired(true)}
    />
  );
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

function getReceiptError(error: unknown): string | null {
  if (!Array.isArray(error) || error.length === 0) return null;
  const first = error[0] as { code?: number; title?: string; message?: string };
  if (typeof first?.code !== "number") return null;
  return `${first.code} — ${first.message ?? first.title ?? "no detail"}`;
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

// `canTakeOver` is owner-only (see POST /api/inbox/takeover for why). Non-owners
// keep "Resume bot" on a thread a human already holds — handing work back to the
// bot is the safe direction and must never need an owner present.
// Threads per request. The list is ordered newest-first, so one page covers a
// normal day's traffic and the rest loads as the admin scrolls.
const THREAD_PAGE_SIZE = 40;

// A search term is interpolated into a PostgREST or=(...) filter, where a
// comma separates conditions, parentheses close the group, and % and * are
// ilike wildcards. Strip them: an admin typing a comma should get no results,
// not a malformed filter or someone else's rows.
function sanitizeSearchTerm(raw: string) {
  return raw.trim().replace(/[,()%*\\"']/g, "");
}

const HOLD_LABELS: Record<number, string> = {
  30: "Hold 30 min",
  120: "Hold 2 jam",
  1440: "Hold 24 jam",
};

export default function InboxClient({ canTakeOver }: { canTakeOver: boolean }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [pinnedThread, setPinnedThread] = useState<Thread | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  // The search box queries the database, so it is debounced — a request per
  // keystroke across 291 threads is the egress problem in miniature.
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    null,
  );
  const [messages, setMessages] = useState<Conversation[]>([]);
  const [manualReply, setManualReply] = useState("");
  const [sending, setSending] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [sendingImage, setSendingImage] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [sendingPdf, setSendingPdf] = useState(false);
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

  // Read inside loadThreads, which must not change identity when a filter or
  // the search term does: it is a dependency of the effect that owns the
  // realtime channel, and rebuilding that channel on every keystroke would
  // drop messages while it reconnects.
  const threadsRef = useRef<Thread[]>([]);
  const hasMoreRef = useRef(false);
  const filterRef = useRef<InboxFilter>("all");
  const searchRef = useRef("");

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    filterRef.current = inboxFilter;
  }, [inboxFilter]);

  // Newest message time and newest receipt time, in two single-row queries of
  // about 70 bytes each. The fallback poll compares this instead of refetching
  // the thread list, which is the whole point: the list is ~85 KB and almost
  // never changes between ticks.
  const watermarkRef = useRef<string | null>(null);

  const readWatermark = useCallback(async () => {
    const [{ data: newest }, { data: receipted }] = await Promise.all([
      supabase
        .from("conversations")
        .select("created_at")
        .order("created_at", { ascending: false })
        .limit(1),
      supabase
        .from("conversations")
        .select("whatsapp_status_updated_at")
        .not("whatsapp_status_updated_at", "is", null)
        .order("whatsapp_status_updated_at", { ascending: false })
        .limit(1),
    ]);
    return `${newest?.[0]?.created_at ?? ""}|${
      receipted?.[0]?.whatsapp_status_updated_at ?? ""
    }`;
  }, [supabase]);

  // One page of threads, one query. inbox_threads (migration 059, extended in
  // 095/096) is one row per customer holding their newest message plus the
  // name, phone and badges the list draws, so the four queries this used to
  // make — threads, the whole customers table, customer_state and
  // customer_flags keyed by an .in() of every id — are now one.
  const loadThreads = useCallback(
    async (mode: "reset" | "append" | "refresh" = "reset") => {
      if (mode === "append" && !hasMoreRef.current) return;

      const loaded = threadsRef.current.length;
      const from = mode === "append" ? loaded : 0;
      // A refresh re-reads everything already on screen, so paging down and
      // then receiving a message does not collapse the list back to one page.
      const size =
        mode === "refresh"
          ? Math.max(loaded, THREAD_PAGE_SIZE)
          : THREAD_PAGE_SIZE;

      let request = supabase
        .from("inbox_threads")
        .select(
          "customer_id, role, content, created_at, customer_name, customer_phone, menu_shown, unanswered",
        )
        .order("created_at", { ascending: false })
        .range(from, from + size - 1);

      // Tab and search filter in the database, not over the loaded page — a
      // filter applied to whichever rows happen to be in the browser answers a
      // different question once the list is paged, and it is the question that
      // hid every lapsed customer's thread before migration 059.
      if (filterRef.current === "unread") request = request.eq("role", "user");
      if (filterRef.current === "unanswered")
        request = request.eq("unanswered", true);

      const term = searchRef.current;
      if (term) {
        request = request.or(
          `customer_name.ilike.%${term}%,customer_phone.ilike.%${term}%,content.ilike.%${term}%`,
        );
      }

      const { data } = await request;
      if (!data) return;

      const page: Thread[] = data.flatMap((row) =>
        row.customer_id && row.customer_phone
          ? [
              {
                customer: {
                  id: row.customer_id,
                  name: row.customer_name,
                  phone_number: row.customer_phone,
                },
                lastMessage: {
                  customer_id: row.customer_id,
                  role: row.role ?? "user",
                  content: row.content ?? "",
                  created_at: row.created_at,
                },
                unread: row.role === "user",
                menuShown: row.menu_shown ?? false,
                unanswered: row.unanswered ?? false,
              },
            ]
          : [],
      );

      hasMoreRef.current = data.length === size;
      setHasMore(hasMoreRef.current);
      setThreads((prev) => (mode === "append" ? [...prev, ...page] : page));
    },
    [supabase],
  );

  useEffect(() => {
    const timer = setTimeout(
      () => setSearchTerm(sanitizeSearchTerm(searchQuery)),
      300,
    );
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Back to page one whenever the question changes. Also the initial load —
  // the realtime effect no longer does one, so the list is fetched once on
  // mount rather than three times.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inboxFilter is the trigger, not a read — loadThreads takes the filter off filterRef so its identity stays stable for the realtime effect
  useEffect(() => {
    searchRef.current = searchTerm;
    void loadThreads("reset");
  }, [inboxFilter, searchTerm, loadThreads]);

  async function loadMoreThreads() {
    if (loadingMore || !hasMoreRef.current) return;
    setLoadingMore(true);
    await loadThreads("append");
    setLoadingMore(false);
  }

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
    const refresh = () => {
      void loadThreads("refresh");
      const current = selectedCustomerIdRef.current;
      if (current) {
        void loadMessages(current);
        // Flags too: another admin taking over this same thread changes only
        // customer_flags, so without this the header keeps offering "Take over"
        // on a chat someone else is already handling.
        void loadFlags(current);
      }
      // Re-read the mark after refetching, so a refresh triggered by realtime
      // does not leave a stale mark for the poll to trip over and refetch again.
      void readWatermark().then((mark) => {
        watermarkRef.current = mark;
      });
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
        () => void loadThreads("refresh"),
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
    // even if the socket is dead. It refetches only when the watermark moved:
    // the unconditional version refetched ~200 KB every 10s, 68 MB an hour per
    // open tab, and that alone put the Supabase project over its 5 GB egress
    // quota with 7 users and a 50 MB database.
    const pollInterval = setInterval(() => {
      void readWatermark().then((mark) => {
        const previous = watermarkRef.current;
        watermarkRef.current = mark;
        if (previous !== null && previous !== mark) refresh();
      });
    }, 10_000);

    // customer_flags carries no timestamp, so a takeover by another admin moves
    // no watermark. Realtime delivers it; this slower sweep is what covers a
    // dead socket, at 1/6th the ticks rather than none.
    const flagPollInterval = setInterval(refresh, 60_000);

    // Refresh immediately when the tab regains focus
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      void supabase.removeChannel(channel);
      clearInterval(pollInterval);
      clearInterval(flagPollInterval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadThreads, loadMessages, loadFlags, readWatermark, supabase]);

  // Scroll to bottom when switching threads; on message updates only if already near bottom
  // biome-ignore lint/correctness/useExhaustiveDependencies: must fire on thread switch only — adding messages would yank the view to the bottom mid-scroll on every poll
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
    setPinnedThread(
      threadsRef.current.find((t) => t.customer.id === customerId) ?? null,
    );
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

  // How long the next takeover holds the bot off. 30 minutes is the old
  // behaviour — the thread comes back on its own once the admin goes quiet.
  const [holdMinutes, setHoldMinutes] = useState<number>(
    TAKEOVER_INACTIVITY_MINUTES,
  );

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
        hold_minutes: holdMinutes,
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

  // Hands the thread back to the bot and lets it answer the customer's last
  // message for real. Unlike regenerateReply this does send, because that is
  // the point of resuming — the customer is waiting on an answer the bot
  // paused to ask about.
  async function resumeBot() {
    if (!selectedCustomerId || !flags) return;
    setRegenerating(true);
    setRegenerateStatus(null);
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
      setRegenerateStatus("Failed to resume bot");
      return;
    }
    if (!body.replayed) {
      setRegenerateStatus(`Not resumed: ${body.reason ?? "unknown"}`);
      return;
    }
    setRegenerateStatus("Bot resumed — reply sent to the customer.");
    await loadMessages(selectedCustomerId);
  }

  // Drafts a reply into the compose box. Sends nothing: the admin edits and
  // presses Send. Deliberately does not clear escalated_to_human — drafting on
  // a thread you took over must not hand it back to the bot.
  async function regenerateReply() {
    if (!selectedCustomerId) return;
    setRegenerating(true);
    setRegenerateStatus(null);
    const res = await fetch("/api/inbox/replay-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: selectedCustomerId, draft: true }),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      replayed?: boolean;
      reason?: string;
      draft?: string;
    } | null;
    setRegenerating(false);
    if (!res.ok || !body?.ok) {
      setRegenerateStatus("Failed to draft reply");
      return;
    }
    if (!body.replayed || !body.draft) {
      setRegenerateStatus(`No draft: ${body.reason ?? "unknown"}`);
      return;
    }
    setManualReply(body.draft);
    setRegenerateStatus("Draft ready below — edit it, then press Send.");
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
      body: JSON.stringify({
        package_size: packageSize,
        customer_id: selectedCustomerId,
        size: extractedOrder?.size,
        subcontractor_id: extractedOrder?.subcontractor_id ?? null,
      }),
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
    await loadThreads("refresh");
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
      sent_by: null,
      created_at: new Date().toISOString(),
      intent: null,
      message_type: null,
      message_id: null,
      media_id: null,
      media_url: null,
      input_tokens: null,
      output_tokens: null,
      whatsapp_status: "sent",
      whatsapp_status_updated_at: new Date().toISOString(),
      whatsapp_error: null,
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
    if (file.type === "application/pdf") {
      cancelImage();
      setPdfFile(file);
    } else {
      setPdfFile(null);
      setImageFile(file);
      setImagePreviewUrl(URL.createObjectURL(file));
    }
    // reset so same file can be picked again
    e.target.value = "";
  }

  function cancelImage() {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(null);
    setImagePreviewUrl(null);
  }

  useEffect(() => {
    if (!flags?.escalated_to_human || !canTakeOver) return;
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        const isImage = item.type.startsWith("image/");
        const isPdf = item.type === "application/pdf";
        if (!isImage && !isPdf) continue;
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        if (isPdf) {
          setPdfFile(file);
        } else {
          setImageFile(file);
          setImagePreviewUrl(URL.createObjectURL(file));
        }
        break;
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [flags?.escalated_to_human, canTakeOver]);

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

  async function sendPdf() {
    if (!selectedCustomerId || !pdfFile) return;
    setSendingPdf(true);
    const form = new FormData();
    form.append("customer_id", selectedCustomerId);
    form.append("file", pdfFile);
    const res = await fetch("/api/inbox/manual-document", {
      method: "POST",
      body: form,
    });
    setSendingPdf(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      alert(`Failed to send PDF: ${body?.error ?? res.statusText}`);
      return;
    }
    setPdfFile(null);
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
    await loadThreads("refresh");
  }

  // The open thread survives a list that no longer contains it: clearing the
  // search box, switching to Unanswered, or scrolling back to page one all
  // rewrite `threads`, and the conversation on screen must not blank because
  // its row moved off the current page.
  const selectedThread =
    threads.find((t) => t.customer.id === selectedCustomerId) ?? pinnedThread;

  // The tab and the search box already filtered in the database. This second
  // pass only catches a row whose flags changed since it was fetched.
  const visibleThreads = filterThreads(threads, inboxFilter);

  return (
    <div className="flex h-[calc(100vh-7rem)] bg-white rounded-xl border border-gray-100 overflow-hidden">
      {/* Thread list */}
      <div
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
            void loadMoreThreads();
          }
        }}
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
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs text-gray-400 truncate">
                {thread.lastMessage.content.slice(0, 60)}
              </p>
              {thread.lastMessage.created_at && (
                <span className="shrink-0 text-[10px] text-gray-400 tabular-nums">
                  {formatThreadTime(thread.lastMessage.created_at)}
                </span>
              )}
            </div>
          </button>
        ))}
        {visibleThreads.length === 0 && (
          <p className="text-xs text-gray-400 p-4">
            {searchTerm
              ? "No conversations match this search."
              : inboxFilter === "all"
                ? "No conversations yet."
                : "No conversations match this filter."}
          </p>
        )}
        {loadingMore && (
          <p className="p-4 text-center text-[10px] text-gray-400">
            Loading older chats…
          </p>
        )}
        {!hasMore && visibleThreads.length > 0 && (
          <p className="p-4 text-center text-[10px] text-gray-300">
            End of conversations
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
              {!flags?.escalated_to_human && canTakeOver && (
                <select
                  value={holdMinutes}
                  onChange={(e) => setHoldMinutes(Number(e.target.value))}
                  className="h-8 rounded-md border border-gray-200 bg-white px-2 text-sm text-gray-700"
                  aria-label="Hold the bot off for"
                >
                  {HOLD_CHOICES_MINUTES.map((m) => (
                    <option key={m} value={m}>
                      {HOLD_LABELS[m]}
                    </option>
                  ))}
                </select>
              )}
              {(flags?.escalated_to_human || canTakeOver) && (
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
              )}
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
                      {regenerating ? "Drafting..." : "Draft bot reply"}
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

          {regenerating && (
            <div className="px-5 py-2 border-b border-blue-100 bg-blue-50 text-xs text-blue-700">
              Menganalisis pesan... cek halaman Assistant sebentar lagi.
            </div>
          )}

          {!regenerating && regenerateStatus && (
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

          {/* Bot paused banner */}
          {flags?.pending_bot_response && !flags?.escalated_to_human && (
            <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-amber-800">
                    Bot paused — awaiting admin input
                  </p>
                  {flags.pending_bot_question && (
                    <p className="mt-0.5 text-amber-700 break-words">
                      {flags.pending_bot_question}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void resumeBot()}
                  disabled={regenerating}
                  className="shrink-0 bg-amber-600 text-white hover:bg-amber-700"
                >
                  {regenerating ? "Resuming..." : "Resume bot"}
                </Button>
              </div>
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
                whatsapp_error?: unknown;
              };
              const imageSrc = getInboxImageSrc(msgWithExtras);
              const imageCaption = getInboxImageCaption(msgWithExtras);
              const docLink = getInboxDocument(msgWithExtras);
              const docCaption = getInboxDocumentCaption(msgWithExtras);
              const receiptLabel = !isUser
                ? getReceiptLabel(msgWithExtras.whatsapp_status ?? null)
                : null;
              // Meta's reason for a failed send. Without it on screen a red
              // "Failed" is undiagnosable — 296 delivery proofs failed silently
              // for two months because the code only ever reached the logs.
              const receiptError = getReceiptError(
                msgWithExtras.whatsapp_error,
              );
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
                        {imageSrc ? (
                          <InboxImage key={imageSrc} src={imageSrc} />
                        ) : (
                          <div className="text-xs italic opacity-70">
                            [Image]
                          </div>
                        )}
                        {imageCaption ? (
                          <p className="whitespace-pre-wrap mt-1.5">
                            {imageCaption}
                          </p>
                        ) : null}
                      </>
                    ) : msgWithExtras.message_type === "document" ? (
                      <>
                        {docLink ? (
                          <a
                            href={docLink.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 underline break-all"
                          >
                            <span>📄</span>
                            <span>{docLink.label}</span>
                          </a>
                        ) : (
                          <div className="text-xs italic opacity-70">
                            [Dokumen]
                          </div>
                        )}
                        {docCaption ? (
                          <p className="whitespace-pre-wrap mt-1.5">
                            {docCaption}
                          </p>
                        ) : null}
                      </>
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
                          {modelRole(msg.model_used) === "sonnet"
                            ? "S"
                            : modelRole(msg.model_used) === "haiku"
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
                          title={receiptError ?? undefined}
                        >
                          {receiptLabel}
                          {receiptError ? ` · ${receiptError}` : ""}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* Manual reply — owner-only. Admins reach customers through the
              Assistant, which records the send and keeps the bot in the loop;
              a thread an owner took over must not become a typing surface for
              everyone else. */}
          {flags?.escalated_to_human && canTakeOver && (
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
              {pdfFile && (
                <div className="px-4 pt-3 pb-2 flex items-start gap-3 bg-gray-50">
                  <div className="h-20 w-20 flex items-center justify-center rounded-lg border border-gray-200 bg-white text-2xl flex-shrink-0">
                    📄
                  </div>
                  <div className="flex flex-col gap-2 min-w-0 flex-1">
                    <p className="text-xs text-gray-500 truncate">
                      {pdfFile.name}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={sendPdf}
                        disabled={sendingPdf}
                        className="bg-orange-500 text-white hover:bg-orange-600"
                      >
                        {sendingPdf ? "Sending..." : "Send PDF"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setPdfFile(null)}
                        disabled={sendingPdf}
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
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={onImagePicked}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={pickImage}
                  title="Attach image or PDF"
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
                      date:
                        o.start_date ?? new Date().toISOString().slice(0, 10),
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
                  setExtractedOrder({
                    ...o,
                    delivery_schedule: rows,
                    package_size: newTotal,
                  });
                  if (patch.portions !== undefined) {
                    void refreshExtractedOrderPricing(newTotal);
                  }
                }

                function removeScheduleRow(idx: number) {
                  const rows = (o.delivery_schedule ?? []).filter(
                    (_, i) => i !== idx,
                  );
                  const newTotal = rows.reduce((s, r) => s + r.portions, 0);
                  setExtractedOrder({
                    ...o,
                    delivery_schedule: rows,
                    package_size: newTotal,
                  });
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
                  setExtractedOrder({
                    ...o,
                    delivery_schedule: newRows,
                    package_size: newTotal,
                  });
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
                          className={
                            !scheduleMode
                              ? "text-blue-600 font-semibold"
                              : "text-gray-400 hover:text-gray-600"
                          }
                        >
                          Seragam
                        </button>
                        <span className="text-gray-300">|</span>
                        <button
                          type="button"
                          onClick={() => !scheduleMode && toggleScheduleMode()}
                          className={
                            scheduleMode
                              ? "text-blue-600 font-semibold"
                              : "text-gray-400 hover:text-gray-600"
                          }
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
                              ...(Number.isFinite(packageSize) &&
                              packageSize > 0
                                ? {}
                                : { price_per_portion: 0, total_price: 0 }),
                            });
                            if (
                              Number.isFinite(packageSize) &&
                              packageSize > 0
                            ) {
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
                            // biome-ignore lint/suspicious/noArrayIndexKey: a slot has no stable id — the row is addressed by position (updateScheduleRow/removeScheduleRow take idx) and two slots can share a date, so position is the only thing identifying it. Every input is controlled, so a shifted key re-renders from props rather than keeping stale text.
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
                                updateScheduleRow(idx, {
                                  meal_type: e.target.value,
                                })
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
                                updateScheduleRow(idx, {
                                  portions: Number(e.target.value),
                                })
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
