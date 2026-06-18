"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

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
  const json = await res.json() as { ok: boolean; data: Instruction[] };
  return json.data;
}

export default function ChatbotTrainingClient() {
  const [tab, setTab] = useState<"chat" | "list" | "simulator">("chat");

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <h1 className="text-xl font-semibold text-gray-900">Chatbot Training</h1>
        <div className="flex border border-gray-200 rounded-lg overflow-hidden text-sm">
          <button type="button" onClick={() => setTab("chat")} className={`px-4 py-1.5 ${tab === "chat" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"}`}>Conversational</button>
          <button type="button" onClick={() => setTab("list")} className={`px-4 py-1.5 ${tab === "list" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"}`}>Instructions</button>
          <button type="button" onClick={() => setTab("simulator")} className={`px-4 py-1.5 ${tab === "simulator" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"}`}>Simulator</button>
        </div>
      </div>

      {tab === "chat" ? <TrainingChat /> : tab === "list" ? <InstructionList /> : <ChatbotSimulator />}
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
      const newMessages: ChatMessage[] = [...messages, { role: "user", content: userMsg }];
      const res = await fetch("/api/training-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });
      return { newMessages, data: await res.json() as { ok: boolean; text: string; savedInstruction: string | null } };
    },
    onSuccess: ({ newMessages, data }) => {
      // Strip [SAVE_INSTRUCTION] block from display
      const displayText = data.text.includes("[SAVE_INSTRUCTION]")
        ? data.text.split("[SAVE_INSTRUCTION]")[0].trim()
        : data.text;

      setMessages([...newMessages, { role: "assistant", content: displayText }]);
      if (data.savedInstruction) {
        setToast("Instruksi berhasil disimpan dan langsung aktif!");
        setTimeout(() => setToast(null), 4000);
      }
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    },
  });

  function handleSend() {
    if (!input.trim() || send.isPending) return;
    send.mutate(input.trim());
    setInput("");
  }

  return (
    <div className="flex flex-col bg-white border border-gray-100 rounded-xl overflow-hidden" style={{ height: "calc(100vh - 200px)" }}>
      {toast && (
        <div className="px-4 py-2 bg-green-50 border-b border-green-100 text-green-700 text-sm">{toast}</div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-gray-400 text-sm text-center pt-12">
            Ceritakan ke saya apa yang ingin kamu ubah dari cara chatbot bekerja.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-2xl px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap ${m.role === "user" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-800"}`}>
              {m.content}
            </div>
          </div>
        ))}
        {send.isPending && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-400 px-4 py-2.5 rounded-2xl text-sm">...</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-gray-100 p-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="Ketik pesan..."
          className="flex-1 border border-gray-200 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-blue-400"
        />
        <button type="button" onClick={handleSend} disabled={!input.trim() || send.isPending} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-xl disabled:opacity-40 hover:bg-blue-700">
          Kirim
        </button>
      </div>
    </div>
  );
}

function InstructionList() {
  const qc = useQueryClient();
  const { data: instructions, isLoading } = useQuery({ queryKey: ["chatbot-instructions"], queryFn: fetchInstructions });
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: async (body: { id: string; instruction?: string; is_active?: boolean }) => {
      await fetch("/api/chatbot-instructions", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["chatbot-instructions"] }); setEditing(null); },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      await fetch("/api/chatbot-instructions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["chatbot-instructions"] }); setConfirmDelete(null); },
  });

  if (isLoading) return <div className="text-gray-400 text-sm">Loading...</div>;

  return (
    <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide">
          <tr>
            <th className="px-4 py-3 text-left">Instruction</th>
            <th className="px-4 py-3 text-left w-24">Active</th>
            <th className="px-4 py-3 text-left w-32">Created</th>
            <th className="px-4 py-3 text-left w-28">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {(instructions ?? []).map((inst) => (
            <tr key={inst.id}>
              <td className="px-4 py-3">
                {editing === inst.id ? (
                  <div className="flex gap-2">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={3}
                      className="flex-1 border border-gray-200 rounded-lg px-2 py-1 text-sm"
                    />
                    <div className="flex flex-col gap-1">
                      <button type="button" onClick={() => patch.mutate({ id: inst.id, instruction: editText })} className="px-2 py-1 bg-blue-600 text-white text-xs rounded">Save</button>
                      <button type="button" onClick={() => setEditing(null)} className="px-2 py-1 border border-gray-200 text-xs rounded">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <p className="text-gray-700 line-clamp-2">{inst.instruction}</p>
                )}
              </td>
              <td className="px-4 py-3">
                <button type="button"
                  onClick={() => patch.mutate({ id: inst.id, is_active: !inst.is_active })}
                  className={`w-10 h-5 rounded-full transition-colors ${inst.is_active ? "bg-blue-600" : "bg-gray-200"} relative`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${inst.is_active ? "translate-x-5" : "translate-x-0.5"}`} />
                </button>
              </td>
              <td className="px-4 py-3 text-gray-400 text-xs">{new Date(inst.created_at).toLocaleDateString("id-ID")}</td>
              <td className="px-4 py-3">
                <div className="flex gap-2">
                  <button type="button" onClick={() => { setEditing(inst.id); setEditText(inst.instruction); }} className="text-blue-500 hover:text-blue-700 text-xs">Edit</button>
                  {confirmDelete === inst.id ? (
                    <span className="flex gap-1">
                      <button type="button" onClick={() => del.mutate(inst.id)} className="text-red-500 text-xs">Hapus</button>
                      <button type="button" onClick={() => setConfirmDelete(null)} className="text-gray-400 text-xs">Batal</button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(inst.id)} className="text-red-400 hover:text-red-600 text-xs">Delete</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {(instructions ?? []).length === 0 && (
            <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No instructions yet. Use Conversational mode to add some.</td></tr>
          )}
        </tbody>
      </table>
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
  const [apiMessages, setApiMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [input, setInput] = useState("");
  const [hasActiveOrder, setHasActiveOrder] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: async (text: string) => {
      const newApiMessages = [...apiMessages, { role: "user" as const, content: text }];
      const res = await fetch("/api/chatbot-simulator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newApiMessages, hasActiveOrder }),
      });
      return { text, newApiMessages, data: await res.json() as { ok: boolean; reply: string; toolCalled: { name: string; input: unknown } | null } };
    },
    onSuccess: ({ text, newApiMessages, data }) => {
      const newItems: SimItem[] = [...items, { kind: "user", text }];
      if (data.reply) newItems.push({ kind: "bot", text: data.reply });
      if (data.toolCalled) newItems.push({ kind: "tool", name: data.toolCalled.name, input: data.toolCalled.input });

      const updatedApiMessages = [...newApiMessages];
      if (data.reply) updatedApiMessages.push({ role: "assistant", content: data.reply });

      setItems(newItems);
      setApiMessages(updatedApiMessages);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    },
  });

  function handleSend() {
    if (!input.trim() || send.isPending) return;
    send.mutate(input.trim());
    setInput("");
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
            onClick={() => { setHasActiveOrder(false); handleReset(); }}
            className={`px-3 py-1 rounded-full border text-xs transition-colors ${!hasActiveOrder ? "bg-gray-900 text-white border-gray-900" : "border-gray-200 hover:bg-gray-50"}`}
          >
            New customer
          </button>
          <button
            type="button"
            onClick={() => { setHasActiveOrder(true); handleReset(); }}
            className={`px-3 py-1 rounded-full border text-xs transition-colors ${hasActiveOrder ? "bg-gray-900 text-white border-gray-900" : "border-gray-200 hover:bg-gray-50"}`}
          >
            Active order (30 of 50 portions left)
          </button>
        </div>
        <button type="button" onClick={handleReset} className="ml-auto text-xs text-gray-400 hover:text-gray-700 px-3 py-1 border border-gray-200 rounded-lg">
          Reset
        </button>
      </div>

      <div className="flex-1 flex flex-col bg-[#e5ddd5] rounded-xl overflow-hidden border border-gray-200">
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {items.length === 0 && (
            <div className="text-center text-sm text-gray-500 pt-12">
              Type a message as if you're a customer. The bot will respond using the real system prompt and active instructions.
            </div>
          )}
          {items.map((item, i) => {
            if (item.kind === "user") {
              return (
                <div key={i} className="flex justify-end">
                  <div className="max-w-xs sm:max-w-md px-3 py-2 rounded-lg bg-[#dcf8c6] text-gray-900 text-sm whitespace-pre-wrap shadow-sm">
                    {item.text}
                  </div>
                </div>
              );
            }
            if (item.kind === "bot") {
              return (
                <div key={i} className="flex justify-start">
                  <div className="max-w-xs sm:max-w-md px-3 py-2 rounded-lg bg-white text-gray-900 text-sm whitespace-pre-wrap shadow-sm">
                    {item.text}
                  </div>
                </div>
              );
            }
            return (
              <div key={i} className="flex justify-center">
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800 max-w-sm w-full">
                  <div className="font-medium mb-1">{TOOL_LABELS[item.name] ?? item.name}</div>
                  <pre className="text-amber-700 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(item.input, null, 2)}</pre>
                </div>
              </div>
            );
          })}
          {send.isPending && (
            <div className="flex justify-start">
              <div className="bg-white px-3 py-2 rounded-lg text-gray-400 text-sm shadow-sm">...</div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="bg-[#f0f0f0] px-3 py-2 flex gap-2 border-t border-gray-200">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Type as a customer..."
            className="flex-1 bg-white border border-gray-200 rounded-full px-4 py-2 text-sm focus:outline-none focus:border-gray-400"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || send.isPending}
            className="px-4 py-2 bg-[#128c7e] text-white text-sm rounded-full disabled:opacity-40 hover:bg-[#0e7064]"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
