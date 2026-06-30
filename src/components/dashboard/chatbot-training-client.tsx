"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface Instruction {
  id: string;
  instruction: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
}

async function fetchInstructions(): Promise<Instruction[]> {
  const res = await fetch("/api/chatbot-instructions");
  const json = (await res.json()) as { ok: boolean; data: Instruction[] };
  return json.data;
}

export default function ChatbotTrainingClient() {
  const [tab, setTab] = useState<"chat" | "context" | "simulator">("chat");

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <h1 className="text-xl font-semibold text-gray-900">
          Chatbot Training
        </h1>
        <div className="flex border border-gray-200 rounded-lg overflow-hidden text-sm">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setTab("chat")}
            className={
              tab === "chat"
                ? "bg-gray-900 text-white hover:bg-gray-900 hover:text-white rounded-none"
                : "text-gray-600 rounded-none"
            }
          >
            Conversational
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setTab("context")}
            className={
              tab === "context"
                ? "bg-gray-900 text-white hover:bg-gray-900 hover:text-white rounded-none"
                : "text-gray-600 rounded-none"
            }
          >
            Konteks
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setTab("simulator")}
            className={
              tab === "simulator"
                ? "bg-gray-900 text-white hover:bg-gray-900 hover:text-white rounded-none"
                : "text-gray-600 rounded-none"
            }
          >
            Simulator
          </Button>
        </div>
      </div>

      {tab === "chat" ? (
        <TrainingChat />
      ) : tab === "context" ? (
        <ContextTab />
      ) : (
        <ChatbotSimulator />
      )}
    </div>
  );
}

function TrainingChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: async (userMsg: string) => {
      const newMessages: ChatMessage[] = [
        ...messages,
        { role: "user", content: userMsg },
      ];
      const res = await fetch("/api/training-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });
      return {
        newMessages,
        data: (await res.json()) as {
          ok: boolean;
          text: string;
          savedInstruction: string | null;
        },
      };
    },
    onSuccess: ({ newMessages, data }) => {
      // Strip [SAVE_INSTRUCTION] block from display
      const displayText = data.text.includes("[SAVE_INSTRUCTION]")
        ? data.text.split("[SAVE_INSTRUCTION]")[0].trim()
        : data.text;

      setMessages([
        ...newMessages,
        { role: "assistant", content: displayText },
      ]);
      if (data.savedInstruction) {
        setToast("Instruksi berhasil disimpan dan langsung aktif!");
        setTimeout(() => setToast(null), 4000);
      }
      setTimeout(
        () => bottomRef.current?.scrollIntoView({ behavior: "smooth" }),
        100,
      );
    },
  });

  function handleSend() {
    if (!input.trim() || send.isPending) return;
    send.mutate(input.trim());
    setInput("");
  }

  return (
    <div
      className="flex flex-col bg-white border border-gray-100 rounded-xl overflow-hidden"
      style={{ height: "calc(100vh - 200px)" }}
    >
      {toast && (
        <div className="px-4 py-2 bg-green-50 border-b border-green-100 text-green-700 text-sm">
          {toast}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-gray-400 text-sm text-center pt-12">
            Ceritakan ke saya apa yang ingin kamu ubah dari cara chatbot
            bekerja.
          </div>
        )}
        {messages.map((m, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: ephemeral chat messages have no stable id
            key={`${m.role}-${i}`}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-2xl px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap ${m.role === "user" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {send.isPending && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-400 px-4 py-2.5 rounded-2xl text-sm">
              ...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-gray-100 p-3 flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ketik pesan..."
          className="flex-1 rounded-xl"
        />
        <Button
          type="button"
          onClick={handleSend}
          disabled={!input.trim() || send.isPending}
          className="bg-blue-600 hover:bg-blue-700 rounded-xl"
        >
          Kirim
        </Button>
      </div>
    </div>
  );
}

interface CustomerSummary {
  id: string;
  name: string | null;
  phone_number: string;
}

interface CustomerDetail {
  id: string;
  name: string | null;
  phone_number: string;
  notes: string | null;
  meal_time_preference: string | null;
  custom_schedule: unknown;
  ad_creative: string | null;
  promo_used: string | null;
  converted_at: string | null;
  customer_state: { state: string } | null;
  customer_flags: {
    escalated_to_human: boolean;
    pending_bot_response: boolean;
    is_blacklisted: boolean;
    vip_status: boolean;
    is_suspicious: boolean;
  } | null;
}

function parseNotes(notes: string | null): { aiContext: string | null; manualNotes: string | null } {
  if (!notes) return { aiContext: null, manualNotes: null };
  const match = notes.match(/\[AI learned context\]([\s\S]*?)\[\/AI learned context\]/);
  if (!match) return { aiContext: null, manualNotes: notes.trim() || null };
  const aiContext = match[1].trim();
  const manualNotes = notes.replace(/\[AI learned context\][\s\S]*?\[\/AI learned context\]/, "").trim() || null;
  return { aiContext, manualNotes };
}

function ContextTab() {
  const [sub, setSub] = useState<"global" | "customer">("global");
  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button
          type="button"
          onClick={() => setSub("global")}
          className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${sub === "global" ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"}`}
        >
          Global
        </button>
        <button
          type="button"
          onClick={() => setSub("customer")}
          className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${sub === "customer" ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100"}`}
        >
          Per Pelanggan
        </button>
      </div>
      {sub === "global" ? <GlobalContext /> : <CustomerContext />}
    </div>
  );
}

function GlobalContext() {
  const qc = useQueryClient();
  const { data: promptData, isLoading: promptLoading } = useQuery({
    queryKey: ["context-preview"],
    queryFn: async () => {
      const res = await fetch("/api/context/preview");
      return (await res.json()) as { ok: boolean; prompt: string };
    },
  });

  const { data: instructions, isLoading: instLoading } = useQuery({
    queryKey: ["chatbot-instructions"],
    queryFn: fetchInstructions,
  });

  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");

  const patch = useMutation({
    mutationFn: async (body: { id: string; instruction?: string; is_active?: boolean }) => {
      await fetch("/api/chatbot-instructions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chatbot-instructions"] });
      setEditing(null);
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      await fetch("/api/chatbot-instructions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chatbot-instructions"] });
      setConfirmDelete(null);
    },
  });

  const add = useMutation({
    mutationFn: async (text: string) => {
      await fetch("/api/chatbot-instructions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: text }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chatbot-instructions"] });
      setAdding(false);
      setNewText("");
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700">System Prompt</h2>
          <span className="text-xs text-gray-400">Preview — konteks pelanggan dikosongkan</span>
        </div>
        {promptLoading ? (
          <div className="text-gray-400 text-sm">Loading...</div>
        ) : (
          <pre className="whitespace-pre-wrap text-xs font-mono bg-gray-50 border border-gray-200 rounded-xl p-4 overflow-y-auto max-h-96 text-gray-700">
            {promptData?.prompt}
          </pre>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700">Instruksi Custom Annie</h2>
          {!adding && (
            <Button
              type="button"
              size="sm"
              onClick={() => setAdding(true)}
              className="bg-blue-600 hover:bg-blue-700 h-7 text-xs"
            >
              + Tambah
            </Button>
          )}
        </div>

        {adding && (
          <div className="mb-3 flex gap-2">
            <Textarea
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              rows={2}
              className="flex-1"
              placeholder="Tulis instruksi baru..."
              autoFocus
            />
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                size="sm"
                onClick={() => add.mutate(newText)}
                disabled={!newText.trim() || add.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Simpan
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => { setAdding(false); setNewText(""); }}
              >
                Batal
              </Button>
            </div>
          </div>
        )}

        {instLoading ? (
          <div className="text-gray-400 text-sm">Loading...</div>
        ) : (
          <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3 text-left">Instruksi</th>
                  <th className="px-4 py-3 text-left w-24">Aktif</th>
                  <th className="px-4 py-3 text-left w-32">Dibuat</th>
                  <th className="px-4 py-3 text-left w-28">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {(instructions ?? []).map((inst) => (
                  <tr key={inst.id}>
                    <td className="px-4 py-3">
                      {editing === inst.id ? (
                        <div className="flex gap-2">
                          <Textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            rows={3}
                            className="flex-1"
                          />
                          <div className="flex flex-col gap-1">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => patch.mutate({ id: inst.id, instruction: editText })}
                              className="bg-blue-600 hover:bg-blue-700"
                            >
                              Save
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setEditing(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-gray-700 line-clamp-2">{inst.instruction}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => patch.mutate({ id: inst.id, is_active: !inst.is_active })}
                        className={`w-10 h-5 rounded-full transition-colors ${inst.is_active ? "bg-blue-600" : "bg-gray-200"} relative`}
                      >
                        <span
                          className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${inst.is_active ? "translate-x-5" : "translate-x-0.5"}`}
                        />
                      </button>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {new Date(inst.created_at).toLocaleDateString("id-ID")}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => { setEditing(inst.id); setEditText(inst.instruction); }}
                          className="text-blue-500 hover:text-blue-700 h-auto py-0 px-1"
                        >
                          Edit
                        </Button>
                        {confirmDelete === inst.id ? (
                          <span className="flex gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => del.mutate(inst.id)}
                              className="text-red-500 h-auto py-0 px-1"
                            >
                              Hapus
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmDelete(null)}
                              className="text-gray-400 h-auto py-0 px-1"
                            >
                              Batal
                            </Button>
                          </span>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmDelete(inst.id)}
                            className="text-red-400 hover:text-red-600 h-auto py-0 px-1"
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {(instructions ?? []).length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                      Belum ada instruksi. Gunakan tab Conversational untuk menambah.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CustomerContext() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editNotes, setEditNotes] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);

  const { data: customers } = useQuery({
    queryKey: ["customers-all"],
    queryFn: async () => {
      const res = await fetch("/api/customers?all=true");
      const json = (await res.json()) as { ok: boolean; data: CustomerSummary[] };
      return json.data;
    },
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["context-customer", selectedId],
    queryFn: async () => {
      const res = await fetch(`/api/context/customer/${selectedId}`);
      const json = (await res.json()) as { ok: boolean; data: CustomerDetail };
      return json.data;
    },
    enabled: !!selectedId,
  });

  const saveNotes = useMutation({
    mutationFn: async (notes: string) => {
      await fetch(`/api/customers/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["context-customer", selectedId] });
      setEditingNotes(false);
    },
  });

  const filtered = (customers ?? []).filter((c) => {
    const q = search.toLowerCase();
    return (c.name ?? "").toLowerCase().includes(q) || c.phone_number.includes(q);
  });

  function selectCustomer(c: CustomerSummary) {
    setSelectedId(c.id);
    setSearch(c.name ?? c.phone_number);
    setOpen(false);
    setEditingNotes(false);
  }

  const { aiContext, manualNotes } = parseNotes(detail?.notes ?? null);

  return (
    <div className="space-y-4 max-w-xl">
      <div className="relative">
        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); if (!e.target.value) setSelectedId(null); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Cari nama atau nomor HP..."
        />
        {open && filtered.length > 0 && (
          <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
            {filtered.slice(0, 20).map((c) => (
              <button
                key={c.id}
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                onMouseDown={() => selectCustomer(c)}
              >
                <span className="font-medium">{c.name ?? "(tanpa nama)"}</span>
                <span className="text-gray-400 ml-2 text-xs">{c.phone_number}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedId && detailLoading && (
        <div className="text-gray-400 text-sm">Loading...</div>
      )}

      {selectedId && detail && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
          <div>
            <p className="font-semibold text-gray-900">{detail.name ?? "(tanpa nama)"}</p>
            <p className="text-xs text-gray-400">{detail.phone_number}</p>
          </div>

          {detail.customer_state && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Pipeline</p>
              <span className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full">
                {detail.customer_state.state}
              </span>
            </div>
          )}

          {detail.customer_flags && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Flags</p>
              <div className="flex flex-wrap gap-1">
                {detail.customer_flags.is_blacklisted && (
                  <span className="px-2 py-0.5 bg-red-50 text-red-700 text-xs rounded-full">Blacklisted</span>
                )}
                {detail.customer_flags.escalated_to_human && (
                  <span className="px-2 py-0.5 bg-orange-50 text-orange-700 text-xs rounded-full">Escalated</span>
                )}
                {detail.customer_flags.pending_bot_response && (
                  <span className="px-2 py-0.5 bg-yellow-50 text-yellow-700 text-xs rounded-full">Waiting bot reply</span>
                )}
                {detail.customer_flags.vip_status && (
                  <span className="px-2 py-0.5 bg-purple-50 text-purple-700 text-xs rounded-full">VIP</span>
                )}
                {detail.customer_flags.is_suspicious && (
                  <span className="px-2 py-0.5 bg-red-50 text-red-600 text-xs rounded-full">Suspicious</span>
                )}
                {!detail.customer_flags.is_blacklisted &&
                  !detail.customer_flags.escalated_to_human &&
                  !detail.customer_flags.pending_bot_response &&
                  !detail.customer_flags.vip_status &&
                  !detail.customer_flags.is_suspicious && (
                    <span className="text-xs text-gray-400">Tidak ada flag aktif</span>
                  )}
              </div>
            </div>
          )}

          {detail.meal_time_preference && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Preferensi makan</p>
              <p className="text-sm text-gray-700">{detail.meal_time_preference}</p>
            </div>
          )}

          {(detail.ad_creative || detail.promo_used || detail.converted_at) && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Konversi</p>
              <div className="text-xs text-gray-600 space-y-0.5">
                {detail.ad_creative && <p>Ad creative: {detail.ad_creative}</p>}
                {detail.promo_used && <p>Promo: {detail.promo_used}</p>}
                {detail.converted_at && (
                  <p>Converted: {new Date(detail.converted_at).toLocaleDateString("id-ID")}</p>
                )}
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-gray-500">Catatan</p>
              {!editingNotes && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => { setEditingNotes(true); setEditNotes(detail.notes ?? ""); }}
                  className="text-blue-500 h-auto py-0 px-1 text-xs"
                >
                  Edit
                </Button>
              )}
            </div>

            {editingNotes ? (
              <div className="space-y-2">
                <Textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={6}
                  className="text-sm"
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => saveNotes.mutate(editNotes)}
                    disabled={saveNotes.isPending}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    {saveNotes.isPending ? "Menyimpan..." : "Simpan"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setEditingNotes(false)}
                  >
                    Batal
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {aiContext && (
                  <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
                    <p className="text-xs text-blue-500 font-medium mb-1">AI learned context</p>
                    <p className="text-xs text-blue-800 whitespace-pre-wrap">{aiContext}</p>
                  </div>
                )}
                {manualNotes && (
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{manualNotes}</p>
                )}
                {!aiContext && !manualNotes && (
                  <p className="text-xs text-gray-400">Belum ada catatan.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type SimItem =
  | { kind: "user"; text: string }
  | { kind: "bot"; text: string }
  | { kind: "tool"; name: string; input: unknown };

const TOOL_LABELS: Record<string, string> = {
  extract_order: "Bot would create an order",
  record_daily_order: "Bot would record a daily delivery",
  ask_admin_for_help: "Bot would ask Annie for help",
  escalate_to_human: "Bot would escalate to Annie",
  mark_payment_proof_received: "Bot would mark payment proof received",
};

function ChatbotSimulator() {
  const [items, setItems] = useState<SimItem[]>([]);
  const [apiMessages, setApiMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const [input, setInput] = useState("");
  const [hasActiveOrder, setHasActiveOrder] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: async (text: string) => {
      const newApiMessages = [
        ...apiMessages,
        { role: "user" as const, content: text },
      ];
      const res = await fetch("/api/chatbot-simulator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newApiMessages, hasActiveOrder }),
      });
      return {
        newApiMessages,
        data: (await res.json()) as {
          ok: boolean;
          reply: string;
          toolCalled: { name: string; input: unknown } | null;
        },
      };
    },
    onSuccess: ({ newApiMessages, data }) => {
      setItems((prev) => {
        const next = [...prev];
        if (data.reply) next.push({ kind: "bot", text: data.reply });
        if (data.toolCalled)
          next.push({
            kind: "tool",
            name: data.toolCalled.name,
            input: data.toolCalled.input,
          });
        return next;
      });

      const updatedApiMessages = [...newApiMessages];
      if (data.reply)
        updatedApiMessages.push({ role: "assistant", content: data.reply });

      setApiMessages(updatedApiMessages);
      setTimeout(
        () => bottomRef.current?.scrollIntoView({ behavior: "smooth" }),
        100,
      );
    },
  });

  function handleSend() {
    if (!input.trim() || send.isPending) return;
    const text = input.trim();
    setItems((prev) => [...prev, { kind: "user", text }]);
    setInput("");
    setTimeout(
      () => bottomRef.current?.scrollIntoView({ behavior: "smooth" }),
      50,
    );
    send.mutate(text);
  }

  function handleReset() {
    setItems([]);
    setApiMessages([]);
    setInput("");
  }

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 200px)" }}>
      <div className="flex items-center gap-3 mb-3">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>Scenario:</span>
          <button
            type="button"
            onClick={() => {
              setHasActiveOrder(false);
              handleReset();
            }}
            className={`px-3 py-1 rounded-full border text-xs transition-colors ${!hasActiveOrder ? "bg-gray-900 text-white border-gray-900" : "border-gray-200 hover:bg-gray-50"}`}
          >
            New customer
          </button>
          <button
            type="button"
            onClick={() => {
              setHasActiveOrder(true);
              handleReset();
            }}
            className={`px-3 py-1 rounded-full border text-xs transition-colors ${hasActiveOrder ? "bg-gray-900 text-white border-gray-900" : "border-gray-200 hover:bg-gray-50"}`}
          >
            Active order (30 of 50 portions left)
          </button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleReset}
          className="ml-auto text-gray-400 hover:text-gray-700"
        >
          Reset
        </Button>
      </div>

      <div className="flex-1 flex flex-col bg-[#e5ddd5] rounded-xl overflow-hidden border border-gray-200">
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {items.length === 0 && (
            <div className="text-center text-sm text-gray-500 pt-12">
              Type a message as if you're a customer. The bot will respond using
              the real system prompt and active instructions.
            </div>
          )}
          {items.map((item, i) => {
            if (item.kind === "user") {
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: chat bubbles are append-only
                <div key={`user-${i}`} className="flex justify-end">
                  <div className="max-w-xs sm:max-w-md px-3 py-2 rounded-lg bg-[#dcf8c6] text-gray-900 text-sm whitespace-pre-wrap shadow-sm">
                    {item.text}
                  </div>
                </div>
              );
            }
            if (item.kind === "bot") {
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: chat bubbles are append-only
                <div key={`bot-${i}`} className="flex justify-start">
                  <div className="max-w-xs sm:max-w-md px-3 py-2 rounded-lg bg-white text-gray-900 text-sm whitespace-pre-wrap shadow-sm">
                    {item.text}
                  </div>
                </div>
              );
            }
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: chat bubbles are append-only
              <div key={`tool-${i}`} className="flex justify-center">
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800 max-w-sm w-full">
                  <div className="font-medium mb-1">
                    {TOOL_LABELS[item.name] ?? item.name}
                  </div>
                  <pre className="text-amber-700 overflow-x-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(item.input, null, 2)}
                  </pre>
                </div>
              </div>
            );
          })}
          {send.isPending && (
            <div className="flex justify-start">
              <div className="bg-white px-3 py-2 rounded-lg text-gray-400 text-sm shadow-sm">
                ...
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="bg-[#f0f0f0] px-3 py-2 flex gap-2 border-t border-gray-200">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Type as a customer..."
            className="flex-1 rounded-full px-4"
          />
          <Button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || send.isPending}
            className="rounded-full bg-[#128c7e] hover:bg-[#0e7064]"
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
