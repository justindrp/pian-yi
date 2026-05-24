"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

interface SettingRow { key: string; value: string; description?: string | null }
interface PricingRow { portions: number; price_per_portion: number }
interface TemplateRow { key: string; template: string; description?: string | null }
interface AdminRow { email: string; created_at: string }

interface SettingsData {
  settings: SettingRow[];
  pricing: PricingRow[];
  templates: TemplateRow[];
  admins: AdminRow[];
}

const BUSINESS_KEYS = ["business_name", "instagram_handle", "bank_name", "bank_account_number", "bank_account_name"];
const DELIVERY_KEYS = ["delivery_areas", "order_deadline_hour"];
const CHATBOT_KEYS = ["chatbot_enabled", "casual_mode_probability", "typing_delay_base_seconds", "typing_delay_per_char_seconds", "typing_delay_max_seconds", "photo_match_confidence_threshold"];
const AUTOMATION_KEYS = ["unpaid_reminder_hours", "unpaid_cancel_hours", "low_quota_first_warning", "low_quota_final_warning"];

async function fetchSettings(): Promise<SettingsData> {
  const res = await fetch("/api/settings");
  const json = await res.json() as { ok: boolean; data: SettingsData };
  return json.data;
}

function useSettingsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Record<string, string>) => {
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ updates }) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}

export default function SettingsClient() {
  const { data, isLoading } = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });

  if (isLoading) return <div className="text-gray-400 text-sm p-4">Loading...</div>;
  if (!data) return null;

  const settingsMap = Object.fromEntries(data.settings.map((s) => [s.key, s.value]));

  return (
    <div className="space-y-8 max-w-3xl">
      <h1 className="text-xl font-semibold text-gray-900">Settings</h1>

      <BusinessSection settingsMap={settingsMap} />
      <PricingSection rows={data.pricing} />
      <DeliverySection settingsMap={settingsMap} />
      <ChatbotSection settingsMap={settingsMap} />
      <AutomationSection settingsMap={settingsMap} />
      <EscalationSection settingsMap={settingsMap} />
      <WeeklyMenuSection settingsMap={settingsMap} />
      <TemplatesSection rows={data.templates} />
      <AdminsSection rows={data.admins} />
    </div>
  );
}

// --- Business Info ---
function BusinessSection({ settingsMap }: { settingsMap: Record<string, string> }) {
  const [form, setForm] = useState(() => Object.fromEntries(BUSINESS_KEYS.map((k) => [k, settingsMap[k] ?? ""])));
  const [confirm, setConfirm] = useState(false);
  const save = useSettingsMutation();

  return (
    <Section title="Business Info">
      <div className="space-y-3">
        {BUSINESS_KEYS.map((k) => (
          <div key={k}>
            <label className="block text-xs text-gray-500 mb-1 capitalize">{k.replace(/_/g, " ")}</label>
            <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form[k] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
          </div>
        ))}
        <ConfirmSaveButton label="Simpan info bisnis?" onConfirm={() => save.mutate(form)} confirm={confirm} setConfirm={setConfirm} loading={save.isPending} />
      </div>
    </Section>
  );
}

// --- Pricing ---
function PricingSection({ rows }: { rows: PricingRow[] }) {
  const qc = useQueryClient();
  const [editPortions, setEditPortions] = useState<number | null>(null);
  const [editPrice, setEditPrice] = useState("");
  const [confirm, setConfirm] = useState(false);

  const save = useMutation({
    mutationFn: async ({ portions, price_per_portion }: { portions: number; price_per_portion: number }) => {
      await fetch("/api/settings/pricing", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ portions, price_per_portion }) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); setEditPortions(null); setConfirm(false); },
  });

  return (
    <Section title="Pricing Tiers">
      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Portions</th>
              <th className="px-4 py-3 text-left">Price/portion</th>
              <th className="px-4 py-3 text-left w-24" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((r) => (
              <tr key={r.portions}>
                <td className="px-4 py-3">{r.portions} porsi</td>
                <td className="px-4 py-3">
                  {editPortions === r.portions ? (
                    <input type="number" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} className="border border-gray-200 rounded px-2 py-1 text-sm w-28" />
                  ) : (
                    `Rp ${r.price_per_portion.toLocaleString("id-ID")}`
                  )}
                </td>
                <td className="px-4 py-3">
                  {editPortions === r.portions ? (
                    <div className="flex gap-1">
                      <button type="button" onClick={() => setConfirm(true)} className="px-2 py-1 bg-blue-600 text-white text-xs rounded">Save</button>
                      <button type="button" onClick={() => setEditPortions(null)} className="px-2 py-1 border text-xs rounded">Cancel</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => { setEditPortions(r.portions); setEditPrice(String(r.price_per_portion)); }} className="text-blue-500 text-xs hover:text-blue-700">Edit</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 space-y-3">
            <p className="font-medium">Perubahan harga hanya berlaku untuk pesanan baru. Pesanan yang sudah ada tidak terpengaruh. Lanjutkan?</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => save.mutate({ portions: editPortions!, price_per_portion: Number(editPrice) })} className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg">Ya, simpan</button>
              <button type="button" onClick={() => setConfirm(false)} className="flex-1 py-2 border text-sm rounded-lg">Batal</button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

// --- Delivery ---
function DeliverySection({ settingsMap }: { settingsMap: Record<string, string> }) {
  const [form, setForm] = useState(() => Object.fromEntries(DELIVERY_KEYS.map((k) => [k, settingsMap[k] ?? ""])));
  const [confirm, setConfirm] = useState(false);
  const save = useSettingsMutation();
  const AREAS = ["BSD", "Gading Serpong", "Alam Sutera", "Bintaro", "Graha Raya"];
  const selectedAreas: string[] = (() => { try { return JSON.parse(form.delivery_areas); } catch { return []; } })();

  return (
    <Section title="Delivery">
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Delivery areas</label>
          <div className="flex flex-wrap gap-1">
            {AREAS.map((a) => (
              <button key={a} type="button"
                onClick={() => setForm((f) => ({ ...f, delivery_areas: JSON.stringify(selectedAreas.includes(a) ? selectedAreas.filter((x) => x !== a) : [...selectedAreas, a]) }))}
                className={`px-2 py-0.5 rounded text-xs border ${selectedAreas.includes(a) ? "bg-blue-100 border-blue-300 text-blue-700" : "border-gray-200 text-gray-500"}`}
              >{a}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Order deadline hour (WIB)</label>
          <input type="number" min={0} max={23} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-24" value={form.order_deadline_hour ?? ""} onChange={(e) => setForm((f) => ({ ...f, order_deadline_hour: e.target.value }))} />
        </div>
        <ConfirmSaveButton label="Simpan delivery settings?" onConfirm={() => save.mutate(form)} confirm={confirm} setConfirm={setConfirm} loading={save.isPending} />
      </div>
    </Section>
  );
}

// --- Chatbot behavior ---
function ChatbotSection({ settingsMap }: { settingsMap: Record<string, string> }) {
  const [form, setForm] = useState(() => Object.fromEntries(CHATBOT_KEYS.map((k) => [k, settingsMap[k] ?? ""])));
  const [confirm, setConfirm] = useState(false);
  const save = useSettingsMutation();

  return (
    <Section title="Chatbot Behavior">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm text-gray-700">Chatbot enabled (kill switch)</label>
          <button type="button"
            onClick={() => { setForm((f) => ({ ...f, chatbot_enabled: f.chatbot_enabled === "true" ? "false" : "true" })); save.mutate({ chatbot_enabled: form.chatbot_enabled === "true" ? "false" : "true" }); }}
            className={`w-12 h-6 rounded-full transition-colors relative ${form.chatbot_enabled === "true" ? "bg-green-500" : "bg-gray-300"}`}
          >
            <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.chatbot_enabled === "true" ? "translate-x-7" : "translate-x-1"}`} />
          </button>
        </div>
        {[
          { key: "casual_mode_probability", label: "Casual mode probability (0–1)" },
          { key: "typing_delay_base_seconds", label: "Typing delay base (sec)" },
          { key: "typing_delay_per_char_seconds", label: "Typing delay per char (sec)" },
          { key: "typing_delay_max_seconds", label: "Typing delay max (sec)" },
          { key: "photo_match_confidence_threshold", label: "Photo match threshold (0–1)" },
        ].map(({ key, label }) => (
          <div key={key}>
            <label className="block text-xs text-gray-500 mb-1">{label}</label>
            <input type="number" step="0.01" className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-32" value={form[key] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
          </div>
        ))}
        <ConfirmSaveButton label="Simpan chatbot settings?" onConfirm={() => save.mutate(form)} confirm={confirm} setConfirm={setConfirm} loading={save.isPending} />
      </div>
    </Section>
  );
}

// --- Automation ---
function AutomationSection({ settingsMap }: { settingsMap: Record<string, string> }) {
  const [form, setForm] = useState(() => Object.fromEntries(AUTOMATION_KEYS.map((k) => [k, settingsMap[k] ?? ""])));
  const [confirm, setConfirm] = useState(false);
  const save = useSettingsMutation();

  const labels: Record<string, string> = {
    unpaid_reminder_hours: "Unpaid reminder (hours)",
    unpaid_cancel_hours: "Unpaid cancel (hours)",
    low_quota_first_warning: "Low quota first warning (portions)",
    low_quota_final_warning: "Low quota final warning (portions)",
  };

  return (
    <Section title="Automation Thresholds">
      <div className="space-y-3">
        {AUTOMATION_KEYS.map((k) => (
          <div key={k}>
            <label className="block text-xs text-gray-500 mb-1">{labels[k]}</label>
            <input type="number" className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-24" value={form[k] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
          </div>
        ))}
        <ConfirmSaveButton label="Simpan automation settings?" onConfirm={() => save.mutate(form)} confirm={confirm} setConfirm={setConfirm} loading={save.isPending} />
      </div>
    </Section>
  );
}

// --- Escalation keywords ---
function EscalationSection({ settingsMap }: { settingsMap: Record<string, string> }) {
  const [keywords, setKeywords] = useState<string[]>(() => { try { return JSON.parse(settingsMap.escalation_keywords ?? "[]"); } catch { return []; } });
  const [newKw, setNewKw] = useState("");
  const [confirm, setConfirm] = useState(false);
  const save = useSettingsMutation();

  return (
    <Section title="Escalation Keywords">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          {keywords.map((kw) => (
            <span key={kw} className="px-2 py-0.5 bg-red-50 border border-red-100 text-red-600 text-xs rounded-full flex items-center gap-1">
              {kw}
              <button type="button" onClick={() => setKeywords((k) => k.filter((x) => x !== kw))} className="text-red-400 hover:text-red-600 ml-1">&times;</button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={newKw} onChange={(e) => setNewKw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newKw.trim()) { setKeywords((k) => [...k, newKw.trim()]); setNewKw(""); } }} placeholder="Add keyword..." className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm" />
          <button type="button" onClick={() => { if (newKw.trim()) { setKeywords((k) => [...k, newKw.trim()]); setNewKw(""); } }} className="px-3 py-1.5 bg-gray-800 text-white text-xs rounded-lg">Add</button>
        </div>
        <ConfirmSaveButton label="Simpan escalation keywords?" onConfirm={() => save.mutate({ escalation_keywords: JSON.stringify(keywords) })} confirm={confirm} setConfirm={setConfirm} loading={save.isPending} />
      </div>
    </Section>
  );
}

// --- Message templates ---
function TemplatesSection({ rows }: { rows: TemplateRow[] }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirm, setConfirm] = useState(false);

  const save = useMutation({
    mutationFn: async ({ key, template }: { key: string; template: string }) => {
      await fetch("/api/settings/templates", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, template }) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); setEditing(null); setConfirm(false); },
  });

  return (
    <Section title="Message Templates">
      <div className="space-y-3">
        {rows.map((t) => (
          <div key={t.key} className="p-4 bg-gray-50 rounded-xl">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <code className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded">{t.key}</code>
                {t.description && <span className="text-xs text-gray-400">{t.description}</span>}
              </div>
              <button type="button" onClick={() => { setEditing(t.key); setEditText(t.template); }} className="text-blue-500 text-xs hover:text-blue-700">Edit</button>
            </div>
            {editing === t.key ? (
              <div className="space-y-2">
                <textarea rows={4} value={editText} onChange={(e) => setEditText(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                <div className="flex gap-2">
                  <button type="button" onClick={() => setConfirm(true)} className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg">Save</button>
                  <button type="button" onClick={() => setEditing(null)} className="px-3 py-1.5 border text-xs rounded-lg">Cancel</button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{t.template}</p>
            )}
          </div>
        ))}
      </div>
      {confirm && editing && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 space-y-3">
            <p className="font-medium">Simpan template {editing}?</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => save.mutate({ key: editing, template: editText })} className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg">Save</button>
              <button type="button" onClick={() => setConfirm(false)} className="flex-1 py-2 border text-sm rounded-lg">Batal</button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

// --- Weekly Menu ---
function WeeklyMenuSection({ settingsMap }: { settingsMap: Record<string, string> }) {
  const [menu, setMenu] = useState(settingsMap.weekly_menu ?? "");
  const [confirm, setConfirm] = useState(false);
  const save = useSettingsMutation();

  return (
    <Section title="Weekly Menu">
      <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-3">
        <p className="text-xs text-gray-400">
          Paste this week's menu here. The chatbot will share it when customers ask. Leave blank to direct customers to Instagram instead.
        </p>
        <textarea
          rows={6}
          value={menu}
          onChange={(e) => { setMenu(e.target.value); setConfirm(false); }}
          placeholder={"SENIN\nLunch: Ayam bakar, tempe orek, tumis kangkung\nDinner: Ikan goreng, tahu balado, sayur asem\n\nSELASA\nLunch: ...\nDinner: ..."}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
        />
        <ConfirmSaveButton
          label="Update weekly menu?"
          confirm={confirm}
          setConfirm={setConfirm}
          loading={save.isPending}
          onConfirm={() => save.mutate({ weekly_menu: menu })}
        />
      </div>
    </Section>
  );
}

// --- Admins ---
function AdminsSection({ rows }: { rows: AdminRow[] }) {
  const qc = useQueryClient();
  const [newEmail, setNewEmail] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState("");

  const add = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch("/api/settings/admins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Failed");
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); setNewEmail(""); setError(""); },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch("/api/settings/admins", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Failed");
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); setConfirmRemove(null); },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Section title="Admin Users">
      <div className="space-y-3">
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Added</th>
                <th className="px-4 py-3 w-16" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map((a) => (
                <tr key={a.email}>
                  <td className="px-4 py-3 text-gray-900">{a.email}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{new Date(a.created_at).toLocaleDateString("id-ID")}</td>
                  <td className="px-4 py-3">
                    <button type="button" onClick={() => setConfirmRemove(a.email)} className="text-red-400 hover:text-red-600 text-xs">Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2">
          <input
            type="email"
            value={newEmail}
            onChange={(e) => { setNewEmail(e.target.value); setError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter" && newEmail.trim()) add.mutate(newEmail.trim()); }}
            placeholder="newadmin@example.com"
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
          <button type="button" onClick={() => { if (newEmail.trim()) add.mutate(newEmail.trim()); }} disabled={add.isPending} className="px-4 py-2 bg-gray-800 text-white text-sm rounded-lg disabled:opacity-40">
            {add.isPending ? "Adding..." : "Add admin"}
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      {confirmRemove && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 space-y-3">
            <p className="font-medium">Remove <span className="text-red-600">{confirmRemove}</span> as admin?</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => remove.mutate(confirmRemove)} disabled={remove.isPending} className="flex-1 py-2 bg-red-600 text-white text-sm rounded-lg disabled:opacity-40">{remove.isPending ? "Removing..." : "Ya, remove"}</button>
              <button type="button" onClick={() => setConfirmRemove(null)} className="flex-1 py-2 border text-sm rounded-lg">Batal</button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

// --- Shared ---
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-700 mb-3">{title}</h2>
      {children}
    </div>
  );
}

function ConfirmSaveButton({ label, onConfirm, confirm, setConfirm, loading }: { label: string; onConfirm: () => void; confirm: boolean; setConfirm: (v: boolean) => void; loading: boolean }) {
  return confirm ? (
    <div className="flex gap-2 items-center">
      <span className="text-sm text-gray-600">{label}</span>
      <button type="button" onClick={onConfirm} disabled={loading} className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg disabled:opacity-40">{loading ? "Saving..." : "Ya, simpan"}</button>
      <button type="button" onClick={() => setConfirm(false)} className="px-3 py-1.5 border text-xs rounded-lg">Batal</button>
    </div>
  ) : (
    <button type="button" onClick={() => setConfirm(true)} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Save changes</button>
  );
}
