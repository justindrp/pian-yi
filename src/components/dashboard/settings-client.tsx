"use client";

import { Switch } from "@/components/ui/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

interface SettingRow { key: string; value: string; description?: string | null }
interface PricingRow { portions: number; price_per_portion: number }
interface TemplateRow { key: string; template: string; description?: string | null }
interface AdminRow { email: string; created_at: string; role: string }

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
      <MessagesSection settingsMap={settingsMap} templates={data.templates} />
      <ChatbotSection settingsMap={settingsMap} />
      <AutomationSection settingsMap={settingsMap} />
      <EscalationSection settingsMap={settingsMap} />
      <WeeklyMenuSection settingsMap={settingsMap} />
      <TemplatesSection rows={data.templates.filter((t) => t.key !== "chatbot_unavailable")} />
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
            <label htmlFor={`business-${k}`} className="block text-xs text-gray-500 mb-1 capitalize">{k.replace(/_/g, " ")}</label>
            <input id={`business-${k}`} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form[k] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
          </div>
        ))}
        <ConfirmSaveButton onConfirm={() => save.mutate(form)} confirm={confirm} setConfirm={setConfirm} loading={save.isPending} success={save.isSuccess} />
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
  const [adjustAmount, setAdjustAmount] = useState("1000");
  const [adjustConfirm, setAdjustConfirm] = useState(false);

  const save = useMutation({
    mutationFn: async ({ portions, price_per_portion }: { portions: number; price_per_portion: number }) => {
      await fetch("/api/settings/pricing", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ portions, price_per_portion }) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); setEditPortions(null); setConfirm(false); },
  });

  const bulkAdjust = useMutation({
    mutationFn: async (adjust: number) => {
      await fetch("/api/settings/pricing", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adjust }) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); setAdjustConfirm(false); },
  });

  const adjustNum = Number(adjustAmount);

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
                <td className="px-4 py-3 text-gray-900">{r.portions} porsi</td>
                <td className="px-4 py-3 text-gray-900">
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

      {/* Bulk adjust */}
      <div className="flex items-center gap-2 mt-3">
        <span className="text-sm text-gray-500">Adjust all tiers by</span>
        <div className="flex">
          <button type="button" onClick={() => { setAdjustAmount((v) => String(Number(v) - 1000)); setAdjustConfirm(false); }} className="px-2 py-1 text-xs border rounded-l-lg border-gray-200 text-gray-500 hover:bg-gray-50">−</button>
          <button type="button" onClick={() => { setAdjustAmount((v) => String(Number(v) + 1000)); setAdjustConfirm(false); }} className="px-2 py-1 text-xs border-y border-r rounded-r-lg border-gray-200 text-gray-500 hover:bg-gray-50">+</button>
        </div>
        <input
          type="number"
          value={adjustAmount}
          onChange={(e) => { setAdjustAmount(e.target.value); setAdjustConfirm(false); }}
          className="border border-gray-200 rounded px-2 py-1 text-sm w-24"
          placeholder="1000"
          min={0}
        />
        <button
          type="button"
          onClick={() => setAdjustConfirm(true)}
          disabled={!adjustNum}
          className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 disabled:opacity-40"
        >
          Apply to all
        </button>
      </div>

      {confirm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 space-y-3">
            <p className="font-medium text-gray-900">Price changes only apply to new orders. Existing orders are not affected. Continue?</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => { if (editPortions === null) return; save.mutate({ portions: editPortions, price_per_portion: Number(editPrice) }); }} className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg">{save.isPending ? "Saving..." : "Confirm"}</button>
              <button type="button" onClick={() => setConfirm(false)} className="flex-1 py-2 border text-sm rounded-lg">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {adjustConfirm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 space-y-3">
            <p className="font-medium text-gray-900">
              {adjustNum > 0 ? "Increase" : "Decrease"} all tiers by Rp {Math.abs(adjustNum).toLocaleString("id-ID")}?
            </p>
            <p className="text-sm text-gray-500">Price changes only apply to new orders. Existing orders are not affected.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => bulkAdjust.mutate(adjustNum)} disabled={bulkAdjust.isPending} className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-40">{bulkAdjust.isPending ? "Saving..." : "Confirm"}</button>
              <button type="button" onClick={() => setAdjustConfirm(false)} className="flex-1 py-2 border text-sm rounded-lg">Cancel</button>
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
  const AREAS = ["BSD Baru", "BSD Lama", "Gading Serpong", "Alam Sutera", "Bintaro", "Graha Raya"];
  const selectedAreas: string[] = (() => { try { return JSON.parse(form.delivery_areas); } catch { return []; } })();

  return (
    <Section title="Delivery">
      <div className="space-y-3">
        <div>
          <p className="block text-xs text-gray-500 mb-1">Delivery areas</p>
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
          <label htmlFor="delivery-order-deadline-hour" className="block text-xs text-gray-500 mb-1">Order deadline hour (WIB)</label>
          <input id="delivery-order-deadline-hour" type="number" min={0} max={23} className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-24" value={form.order_deadline_hour ?? ""} onChange={(e) => setForm((f) => ({ ...f, order_deadline_hour: e.target.value }))} />
        </div>
        <ConfirmSaveButton onConfirm={() => save.mutate(form)} confirm={confirm} setConfirm={setConfirm} loading={save.isPending} success={save.isSuccess} />
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
          <label htmlFor="chatbot-enabled" className="text-sm text-gray-700">Chatbot enabled (kill switch)</label>
          <Switch
            id="chatbot-enabled"
            checked={form.chatbot_enabled === "true"}
            onCheckedChange={(checked) => {
              const val = checked ? "true" : "false";
              setForm((f) => ({ ...f, chatbot_enabled: val }));
              save.mutate({ chatbot_enabled: val });
            }}
          />
        </div>
        {[
          { key: "casual_mode_probability", label: "Casual mode probability (0–1)" },
          { key: "typing_delay_base_seconds", label: "Typing delay base (sec)" },
          { key: "typing_delay_per_char_seconds", label: "Typing delay per char (sec)" },
          { key: "typing_delay_max_seconds", label: "Typing delay max (sec)" },
          { key: "photo_match_confidence_threshold", label: "Photo match threshold (0–1)" },
        ].map(({ key, label }) => (
          <div key={key}>
            <label htmlFor={`chatbot-${key}`} className="block text-xs text-gray-500 mb-1">{label}</label>
            <input id={`chatbot-${key}`} type="number" step="0.01" className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-32" value={form[key] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
          </div>
        ))}
        <ConfirmSaveButton onConfirm={() => save.mutate(form)} confirm={confirm} setConfirm={setConfirm} loading={save.isPending} success={save.isSuccess} />
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
            <label htmlFor={`automation-${k}`} className="block text-xs text-gray-500 mb-1">{labels[k]}</label>
            <input id={`automation-${k}`} type="number" className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-24" value={form[k] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
          </div>
        ))}
        <ConfirmSaveButton onConfirm={() => save.mutate(form)} confirm={confirm} setConfirm={setConfirm} loading={save.isPending} success={save.isSuccess} />
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
        <ConfirmSaveButton onConfirm={() => save.mutate({ escalation_keywords: JSON.stringify(keywords) })} confirm={confirm} setConfirm={setConfirm} loading={save.isPending} success={save.isSuccess} />
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
            <p className="font-medium text-gray-900">Simpan template {editing}?</p>
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
const MENU_IMAGE_KEYS: { key: string; label: string }[] = [
  { key: "price_list_image_url", label: "Price list image" },
];

function MenuImageUploader({ settingKey, label, currentUrl }: { settingKey: string; label: string; currentUrl: string }) {
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [error, setError] = useState("");

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    setUploaded(false);
    const form = new FormData();
    form.append("file", file);
    form.append("key", settingKey);
    const res = await fetch("/api/settings/menu-image", { method: "POST", body: form });
    const json = await res.json() as { ok: boolean; error?: string };
    setUploading(false);
    if (json.ok) {
      setUploaded(true);
      qc.invalidateQueries({ queryKey: ["settings"] });
      setTimeout(() => setUploaded(false), 3000);
    } else {
      setError(json.error ?? "Upload failed");
    }
    e.target.value = "";
  }

  return (
    <div className="space-y-2">
      <p className="block text-xs text-gray-500">{label}</p>
      {currentUrl && (
        <a href={currentUrl} target="_blank" rel="noreferrer">
          <img src={currentUrl} alt={label} className="h-24 w-auto rounded-lg border border-gray-200 object-cover" />
        </a>
      )}
      <div className="flex items-center gap-2">
        <label htmlFor={`menu-image-${settingKey}`} className={`px-3 py-1.5 text-xs rounded-lg border cursor-pointer ${uploading ? "opacity-40 pointer-events-none" : "hover:bg-gray-50"} border-gray-200 text-gray-700`}>
          {uploading ? "Uploading..." : currentUrl ? "Replace" : "Upload"}
          <input id={`menu-image-${settingKey}`} type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={uploading} />
        </label>
        {uploaded && <span className="text-xs text-green-600">Saved!</span>}
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    </div>
  );
}

function WeeklyMenuSection({ settingsMap }: { settingsMap: Record<string, string> }) {
  return (
    <Section title="Price List">
      <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-4">
        <p className="text-xs text-gray-400">Sent to new customers automatically on first contact. Menu images are managed per subcontractor.</p>
        {MENU_IMAGE_KEYS.map(({ key, label }) => (
          <MenuImageUploader key={key} settingKey={key} label={label} currentUrl={settingsMap[key] ?? ""} />
        ))}
      </div>
    </Section>
  );
}

// --- Admins ---
function AdminsSection({ rows }: { rows: AdminRow[] }) {
  const qc = useQueryClient();
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "owner">("admin");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState("");

  const add = useMutation({
    mutationFn: async ({ email, role }: { email: string; role: string }) => {
      const res = await fetch("/api/settings/admins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role }) });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Failed");
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); setNewEmail(""); setNewRole("admin"); setError(""); },
    onError: (e: Error) => setError(e.message),
  });

  const changeRole = useMutation({
    mutationFn: async ({ email, role }: { email: string; role: string }) => {
      const res = await fetch("/api/settings/admins", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role }) });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "Failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
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
                <th className="px-4 py-3 text-left">Role</th>
                <th className="px-4 py-3 text-left">Added</th>
                <th className="px-4 py-3 w-16" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map((a) => (
                <tr key={a.email}>
                  <td className="px-4 py-3 text-gray-900">{a.email}</td>
                  <td className="px-4 py-3">
                    <select
                      value={a.role}
                      onChange={(e) => changeRole.mutate({ email: a.email, role: e.target.value })}
                      className="border border-gray-200 rounded px-2 py-1 text-xs text-gray-700 bg-white"
                    >
                      <option value="admin">admin</option>
                      <option value="owner">owner</option>
                    </select>
                  </td>
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
            onKeyDown={(e) => { if (e.key === "Enter" && newEmail.trim()) add.mutate({ email: newEmail.trim(), role: newRole }); }}
            placeholder="newadmin@example.com"
            className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as "admin" | "owner")}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
          >
            <option value="admin">admin</option>
            <option value="owner">owner</option>
          </select>
          <button type="button" onClick={() => { if (newEmail.trim()) add.mutate({ email: newEmail.trim(), role: newRole }); }} disabled={add.isPending} className="px-4 py-2 bg-gray-800 text-white text-sm rounded-lg disabled:opacity-40">
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

// --- Messages ---
function MessagesSection({ settingsMap, templates }: { settingsMap: Record<string, string>; templates: TemplateRow[] }) {
  const qc = useQueryClient();
  const [greeting, setGreeting] = useState(settingsMap.welcome_message ?? "");
  const [greetingConfirm, setGreetingConfirm] = useState(false);

  const awayTemplate = templates.find((t) => t.key === "chatbot_unavailable");
  const [away, setAway] = useState(awayTemplate?.template ?? "");
  const [awayConfirm, setAwayConfirm] = useState(false);

  const saveGreeting = useSettingsMutation();

  const saveAway = useMutation({
    mutationFn: async (template: string) => {
      await fetch("/api/settings/templates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "chatbot_unavailable", template }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <Section title="Messages">
      <div className="space-y-6">
        <div className="space-y-2">
          <label htmlFor="settings-greeting-message" className="block text-xs text-gray-500">
            Greeting message <span className="text-gray-400">— sent to new customers on first contact</span>
          </label>
          <textarea
            id="settings-greeting-message"
            rows={5}
            value={greeting}
            onChange={(e) => { setGreeting(e.target.value); setGreetingConfirm(false); }}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
          />
          <ConfirmSaveButton
            onConfirm={() => saveGreeting.mutate({ welcome_message: greeting })}
            confirm={greetingConfirm}
            setConfirm={setGreetingConfirm}
            loading={saveGreeting.isPending}
            success={saveGreeting.isSuccess}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="settings-away-message" className="block text-xs text-gray-500">
            Away message <span className="text-gray-400">— sent when chatbot is disabled</span>
          </label>
          <textarea
            id="settings-away-message"
            rows={3}
            value={away}
            onChange={(e) => { setAway(e.target.value); setAwayConfirm(false); }}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
          />
          <ConfirmSaveButton
            onConfirm={() => saveAway.mutate(away)}
            confirm={awayConfirm}
            setConfirm={setAwayConfirm}
            loading={saveAway.isPending}
            success={saveAway.isSuccess}
          />
        </div>
      </div>
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

function ConfirmSaveButton({ onConfirm, confirm, setConfirm, loading, success }: { onConfirm: () => void; confirm: boolean; setConfirm: (v: boolean) => void; loading: boolean; success?: boolean }) {
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (success) {
      setShowSaved(true);
      setConfirm(false);
      const t = setTimeout(() => setShowSaved(false), 2000);
      return () => clearTimeout(t);
    }
  }, [success, setConfirm]);

  if (showSaved) {
    return <span className="text-sm text-green-600 font-medium">Saved!</span>;
  }
  return confirm ? (
    <div className="flex gap-2 items-center">
      <span className="text-sm text-gray-600">Save changes?</span>
      <button type="button" onClick={onConfirm} disabled={loading} className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg disabled:opacity-40">{loading ? "Saving..." : "Confirm"}</button>
      <button type="button" onClick={() => setConfirm(false)} className="px-3 py-1.5 border text-xs rounded-lg">Cancel</button>
    </div>
  ) : (
    <button type="button" onClick={() => setConfirm(true)} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Save changes</button>
  );
}
