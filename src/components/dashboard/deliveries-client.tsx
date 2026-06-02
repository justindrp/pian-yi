"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

interface DeliveryRow {
  id?: string;
  customer_id: string;
  order_id: string;
  meal_type: "lunch" | "dinner";
  portions: number;
  subcontractor_id: string | null;
  notes: string | null;
  status: string;
  skip: boolean;
  customers?: { name: string | null; phone_number: string; area: string; subcontractor_id: string | null };
  orders?: { portions_lunch: number; portions_dinner: number; portions_per_delivery: number; meal_time_preference: string };
}

interface Proof {
  id: string;
  caption: string | null;
  image_url: string | null;
  signed_url: string | null;
  status: string;
  match_confidence: number | null;
  sent_to_customer_at: string | null;
  subcontractors: { name: string } | null;
  customers: { name: string | null; phone_number: string } | null;
  matched_customer_id: string | null;
}

interface Sub { id: string; name: string }

function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function isPastDeadline(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  // Deadline is the day before the delivery date at 8pm local time
  const deadline = new Date(y, m - 1, d - 1, 20, 0, 0);
  return new Date() > deadline;
}

function buildSubcontractorSummary(rows: DeliveryRow[], subs: Sub[], subId: string, date: string): string {
  const sub = subs.find((s) => s.id === subId);
  const subRows = rows.filter((r) => r.subcontractor_id === subId && !r.skip);
  const lunch = subRows.filter((r) => r.meal_type === "lunch");
  const dinner = subRows.filter((r) => r.meal_type === "dinner");
  const total = subRows.reduce((s, r) => s + r.portions, 0);

  const dateStr = new Date(date).toLocaleDateString("id-ID", { day: "numeric", month: "long" });
  let text = `🍱 *Pengiriman ${sub?.name ?? subId} - ${dateStr}*\n`;

  if (lunch.length) {
    text += "\n*LUNCH*\n";
    lunch.forEach((r, i) => {
      text += `${i + 1}. ${r.customers?.name ?? "?"} - ${r.customers?.area ?? "?"} - ${r.portions} porsi\n`;
    });
  }
  if (dinner.length) {
    text += "\n*DINNER*\n";
    dinner.forEach((r, i) => {
      text += `${i + 1}. ${r.customers?.name ?? "?"} - ${r.customers?.area ?? "?"} - ${r.portions} porsi\n`;
    });
  }
  text += `\nTotal: ${total} porsi`;
  return text;
}

export default function DeliveriesClient() {
  const [tab, setTab] = useState<"sheet" | "proofs">("sheet");
  const [date, setDate] = useState(tomorrow());
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [copiedSub, setCopiedSub] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: sheetData, isLoading: sheetLoading } = useQuery({
    queryKey: ["daily-sheet", date],
    queryFn: async () => {
      const res = await fetch(`/api/deliveries/daily-sheet?date=${date}`);
      const json = await res.json() as { ok: boolean; data: DeliveryRow[] };
      return json.data;
    },
  });

  const { data: subs } = useQuery({
    queryKey: ["subcontractors"],
    queryFn: async () => {
      const res = await fetch("/api/subcontractors");
      const json = await res.json() as { ok: boolean; data: Sub[] };
      return json.data;
    },
  });

  const { data: proofs, isLoading: proofsLoading } = useQuery({
    queryKey: ["delivery-proofs", date],
    queryFn: async () => {
      const res = await fetch(`/api/deliveries/proofs?date=${date}`);
      const json = await res.json() as { ok: boolean; data: Proof[] };
      return json.data;
    },
    refetchInterval: tab === "proofs" ? 15000 : false,
    enabled: tab === "proofs",
  });

  useEffect(() => {
    if (sheetData) {
      setRows(sheetData.map((r) => ({ ...r, skip: r.status === "skipped" })));
    }
  }, [sheetData]);

  const generate = useMutation({
    mutationFn: async () => {
      await fetch("/api/deliveries/daily-sheet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date }) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["daily-sheet", date] });
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      await fetch("/api/deliveries/daily-sheet", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, rows }),
      });
    },
    onSuccess: () => { setShowConfirm(false); qc.invalidateQueries({ queryKey: ["daily-sheet", date] }); },
  });

  const sendProof = useMutation({
    mutationFn: async ({ id, customer_id }: { id: string; customer_id: string }) => {
      await fetch("/api/deliveries/proofs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "send", customer_id }) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["delivery-proofs", date] }),
  });

  const unmatchProof = useMutation({
    mutationFn: async (id: string) => {
      await fetch("/api/deliveries/proofs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "unmatch" }) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["delivery-proofs", date] }),
  });

  const lunchRows = rows.filter((r) => r.meal_type === "lunch");
  const dinnerRows = rows.filter((r) => r.meal_type === "dinner");
  const uniqueSubs = [...new Set(rows.filter((r) => r.subcontractor_id).map((r) => r.subcontractor_id as string))];

  const autoSent = (proofs ?? []).filter((p) => p.status === "auto_sent");
  const needsReview = (proofs ?? []).filter((p) => p.status === "needs_review");
  const unmatched = (proofs ?? []).filter((p) => p.status === "unmatched");

  function updateRow(idx: number, field: keyof DeliveryRow, value: unknown) {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  }

  function globalIdx(mealRows: DeliveryRow[], localIdx: number) {
    return rows.indexOf(mealRows[localIdx]);
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <h1 className="text-xl font-semibold text-gray-900">Deliveries</h1>
        <div className="flex border border-gray-200 rounded-lg overflow-hidden text-sm">
          <button type="button" onClick={() => setTab("sheet")} className={`px-4 py-1.5 ${tab === "sheet" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"}`}>Daily Sheet</button>
          <button type="button" onClick={() => setTab("proofs")} className={`px-4 py-1.5 ${tab === "proofs" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"}`}>Proof of Delivery</button>
        </div>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm ml-auto" />
      </div>

      {tab === "sheet" && (
        <div>
          {isPastDeadline(date) && (
            <div className="mb-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
              ⚠️ Deadline sudah lewat. Perubahan ini harus dikomunikasikan langsung ke subcontractor.
            </div>
          )}

          {/* Summary */}
          <div className="flex gap-4 mb-4">
            <div className="bg-white border border-gray-100 rounded-lg px-4 py-3 text-sm">
              <div className="text-gray-500 text-xs">Total Lunch</div>
              <div className="font-semibold text-gray-900">{lunchRows.filter((r) => !r.skip).reduce((s, r) => s + r.portions, 0)} porsi</div>
            </div>
            <div className="bg-white border border-gray-100 rounded-lg px-4 py-3 text-sm">
              <div className="text-gray-500 text-xs">Total Dinner</div>
              <div className="font-semibold text-gray-900">{dinnerRows.filter((r) => !r.skip).reduce((s, r) => s + r.portions, 0)} porsi</div>
            </div>
            <div className="flex gap-2 ml-auto">
              <button type="button" onClick={() => generate.mutate()} disabled={generate.isPending} className="px-4 py-2 border border-gray-200 text-gray-900 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-40">
                {generate.isPending ? "Refreshing..." : "Refresh"}
              </button>
              <button type="button" onClick={() => setShowConfirm(true)} disabled={rows.length === 0} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-40">Save</button>
            </div>
          </div>

          {sheetLoading ? (
            <div className="text-gray-400 text-sm">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="text-gray-400 text-sm text-center py-12">No deliveries for this date. Click Refresh to load from active orders.</div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {(["lunch", "dinner"] as const).map((meal) => {
                const mealRows = meal === "lunch" ? lunchRows : dinnerRows;
                return (
                  <div key={meal}>
                    <h2 className="font-medium text-gray-700 text-sm mb-2 uppercase tracking-wide">{meal}</h2>
                    <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-400 text-xs">
                          <tr>
                            <th className="px-3 py-2 text-left">✓</th>
                            <th className="px-3 py-2 text-left">Customer</th>
                            <th className="px-3 py-2 text-left">Portions</th>
                            <th className="px-3 py-2 text-left">Subcontractor</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {mealRows.map((r, li) => {
                            const gi = globalIdx(mealRows, li);
                            return (
                              <tr key={`${r.customer_id}-${meal}`} className={r.skip ? "opacity-40" : ""}>
                                <td className="px-3 py-2">
                                  <input type="checkbox" checked={!r.skip} onChange={(e) => updateRow(gi, "skip", !e.target.checked)} />
                                </td>
                                <td className="px-3 py-2">
                                  <div className="font-medium text-gray-900">{r.customers?.name ?? r.customer_id.slice(0, 8)}</div>
                                  <div className="text-xs text-gray-400">{r.customers?.area}</div>
                                </td>
                                <td className="px-3 py-2">
                                  <div className="flex items-center gap-1">
                                    <button type="button" onClick={() => updateRow(gi, "portions", Math.max(1, r.portions - 1))} className="w-5 h-5 rounded border text-xs">-</button>
                                    <span className="w-6 text-center">{r.portions}</span>
                                    <button type="button" onClick={() => updateRow(gi, "portions", r.portions + 1)} className="w-5 h-5 rounded border text-xs">+</button>
                                  </div>
                                </td>
                                <td className="px-3 py-2">
                                  <select
                                    value={r.subcontractor_id ?? ""}
                                    onChange={(e) => updateRow(gi, "subcontractor_id", e.target.value || null)}
                                    className="text-xs border border-gray-200 rounded px-1 py-0.5"
                                  >
                                    <option value="">—</option>
                                    {(subs ?? []).filter((s: Sub & { is_active?: boolean }) => s.is_active !== false).map((s: Sub) => (
                                      <option key={s.id} value={s.id}>{s.name}</option>
                                    ))}
                                  </select>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Copy for subcontractors */}
          {rows.length > 0 && uniqueSubs.length > 0 && (
            <div className="mt-4 flex gap-2">
              {uniqueSubs.map((subId) => {
                const sub = (subs ?? []).find((s: Sub) => s.id === subId);
                return (
                  <button
                    key={subId}
                    type="button"
                    onClick={() => {
                      const text = buildSubcontractorSummary(rows, subs ?? [], subId, date);
                      navigator.clipboard.writeText(text).then(() => { setCopiedSub(subId); setTimeout(() => setCopiedSub(null), 2000); });
                    }}
                    className="px-3 py-1.5 border border-gray-200 text-sm rounded-lg hover:bg-gray-50"
                  >
                    {copiedSub === subId ? "Copied!" : `Copy for ${sub?.name ?? subId}`}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "proofs" && (
        <div className="space-y-6">
          {/* Auto-sent */}
          <div>
            <h2 className="font-medium text-gray-700 text-sm mb-2">Auto-matched & sent ({autoSent.length})</h2>
            {autoSent.length === 0 ? <p className="text-gray-400 text-sm">None today.</p> : (
              <div className="grid grid-cols-3 gap-3">
                {autoSent.map((p) => (
                  <div key={p.id} className="bg-white border border-gray-100 rounded-xl p-3">
                    {p.signed_url && <img src={p.signed_url} alt="proof" className="w-full h-32 object-cover rounded-lg mb-2" />}
                    <div className="text-xs text-gray-600">{p.customers?.name ?? "Unknown"}</div>
                    <div className="text-xs text-gray-400">Confidence: {p.match_confidence ? `${Math.round(p.match_confidence * 100)}%` : "—"}</div>
                    <div className="text-xs text-gray-400">{p.sent_to_customer_at ? new Date(p.sent_to_customer_at).toLocaleTimeString("id-ID") : ""}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Needs review */}
          <div>
            <h2 className="font-medium text-gray-700 text-sm mb-2">Needs review ({needsReview.length})</h2>
            {needsReview.length === 0 ? <p className="text-gray-400 text-sm">None pending.</p> : (
              <div className="space-y-3">
                {needsReview.map((p) => (
                  <ReviewProofCard key={p.id} proof={p} date={date} onSend={(customer_id) => sendProof.mutate({ id: p.id, customer_id })} onUnmatch={() => unmatchProof.mutate(p.id)} />
                ))}
              </div>
            )}
          </div>

          {/* Unmatched */}
          <div>
            <h2 className="font-medium text-gray-700 text-sm mb-2">Unmatched ({unmatched.length})</h2>
            {unmatched.length === 0 ? <p className="text-gray-400 text-sm">None.</p> : (
              <div className="grid grid-cols-3 gap-3">
                {unmatched.map((p) => (
                  <div key={p.id} className="bg-white border border-gray-100 rounded-xl p-3 opacity-60">
                    {p.signed_url && <img src={p.signed_url} alt="proof" className="w-full h-32 object-cover rounded-lg mb-2" />}
                    <div className="text-xs text-gray-500">{p.caption ?? "No caption"}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Save confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 space-y-4">
            <h2 className="font-semibold text-gray-900">Simpan pengiriman untuk {date}?</h2>
            <p className="text-sm text-gray-500">Ini akan mengurangi kuota pelanggan.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-40">{save.isPending ? "Saving..." : "Simpan"}</button>
              <button type="button" onClick={() => setShowConfirm(false)} className="flex-1 py-2 border border-gray-200 text-sm rounded-lg">Batal</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewProofCard({ proof, date, onSend, onUnmatch }: { proof: Proof; date: string; onSend: (customerId: string) => void; onUnmatch: () => void }) {
  const { data: sheetData } = useQuery({
    queryKey: ["daily-sheet", date],
    queryFn: async () => {
      const res = await fetch(`/api/deliveries/daily-sheet?date=${date}`);
      const json = await res.json() as { ok: boolean; data: Array<{ customer_id: string; customers?: { name: string | null } }> };
      return json.data;
    },
  });

  const [selectedCustomer, setSelectedCustomer] = useState(proof.matched_customer_id ?? "");

  const customers = [...new Map((sheetData ?? []).map((r) => [r.customer_id, r.customers?.name ?? r.customer_id.slice(0, 8)])).entries()];

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-4 flex gap-4">
      {proof.signed_url && <img src={proof.signed_url} alt="proof" className="w-32 h-32 object-cover rounded-lg flex-shrink-0" />}
      <div className="flex-1 space-y-2">
        <div className="text-xs text-gray-500">From: {proof.subcontractors?.name ?? "Unknown"}</div>
        {proof.caption && <div className="text-sm text-gray-700">"{proof.caption}"</div>}
        {proof.match_confidence !== null && (
          <div className="text-xs text-gray-400">AI confidence: {Math.round((proof.match_confidence ?? 0) * 100)}%</div>
        )}
        <select value={selectedCustomer} onChange={(e) => setSelectedCustomer(e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm">
          <option value="">Select customer...</option>
          {customers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div className="flex gap-2">
          <button type="button" onClick={() => onSend(selectedCustomer)} disabled={!selectedCustomer} className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg disabled:opacity-40">Send</button>
          <button type="button" onClick={onUnmatch} className="px-3 py-1.5 border border-gray-200 text-xs rounded-lg text-gray-500">Can't match</button>
        </div>
      </div>
    </div>
  );
}
