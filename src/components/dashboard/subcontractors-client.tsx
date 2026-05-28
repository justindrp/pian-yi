"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

interface OffDay {
  id: string;
  off_date: string;
  reason: string | null;
}

interface Subcontractor {
  id: string;
  name: string;
  customer_nickname: string | null;
  admin_phone: string | null;
  admin_phone_2: string | null;
  delivery_areas: string[] | null;
  notes: string | null;
  is_active: boolean;
  late_delivery_count: number;
  total_delivery_count: number;
  created_at: string;
  subcontractor_off_days: OffDay[];
}

const AREAS = ["BSD Baru", "BSD Lama", "Gading Serpong", "Alam Sutera", "Bintaro", "Graha Raya"];

async function fetchSubcontractors(): Promise<Subcontractor[]> {
  const res = await fetch("/api/subcontractors");
  const json = await res.json() as { ok: boolean; data: Subcontractor[] };
  return json.data;
}

export default function SubcontractorsClient() {
  const qc = useQueryClient();
  const { data: subs, isLoading } = useQuery({ queryKey: ["subcontractors"], queryFn: fetchSubcontractors });

  const [selected, setSelected] = useState<Subcontractor | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Subcontractor>>({});
  const [addForm, setAddForm] = useState({ name: "", customer_nickname: "", admin_phone: "", admin_phone_2: "", delivery_areas: [] as string[], notes: "" });
  const [offDayForm, setOffDayForm] = useState({ off_date: "", reason: "" });
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const patchSub = useMutation({
    mutationFn: async ({ id, ...body }: Partial<Subcontractor> & { id: string }) => {
      await fetch(`/api/subcontractors/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["subcontractors"] }); setConfirmDeactivate(false); },
  });

  const addSub = useMutation({
    mutationFn: async () => {
      await fetch("/api/subcontractors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(addForm) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["subcontractors"] }); setShowAdd(false); setAddForm({ name: "", customer_nickname: "", admin_phone: "", admin_phone_2: "", delivery_areas: [], notes: "" }); },
  });

  const addOffDay = useMutation({
    mutationFn: async () => {
      await fetch("/api/subcontractors/off-days", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subcontractor_id: selected?.id, ...offDayForm }) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["subcontractors"] }); setOffDayForm({ off_date: "", reason: "" }); },
  });

  const deleteOffDay = useMutation({
    mutationFn: async (id: string) => {
      await fetch("/api/subcontractors/off-days", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subcontractors"] }),
  });

  if (isLoading) return <div className="p-6 text-gray-400 text-sm">Loading...</div>;

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex gap-6">
      {/* List */}
      <div className="flex-1">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold text-gray-900">Subcontractors</h1>
          <button onClick={() => setShowAdd(true)} className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Add</button>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Nickname (Dapur)</th>
                <th className="px-4 py-3 text-left">Areas</th>
                <th className="px-4 py-3 text-left">Admin Phone</th>
                <th className="px-4 py-3 text-left">On-time rate</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {(subs ?? []).map((s) => {
                const onTimeRate = s.total_delivery_count > 0
                  ? Math.round(((s.total_delivery_count - s.late_delivery_count) / s.total_delivery_count) * 100)
                  : null;
                return (
                  <tr key={s.id} onClick={() => { setSelected(s); setEditForm(s); }} className="cursor-pointer hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{s.name}</td>
                    <td className="px-4 py-3 text-gray-900">{s.customer_nickname ?? <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-3 text-gray-500">{(s.delivery_areas ?? []).join(", ")}</td>
                    <td className="px-4 py-3 text-gray-500">{s.admin_phone ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-500">{onTimeRate !== null ? `${onTimeRate}%` : "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${s.is_active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                        {s.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail slide-over */}
      {selected && (
        <div className="w-96 bg-white border border-gray-100 rounded-xl p-5 space-y-4 flex-shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">{selected.name}</h2>
            <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
          </div>

          {/* Edit form */}
          <div className="space-y-3">
            {(["name", "customer_nickname", "admin_phone", "admin_phone_2", "notes"] as const).map((field) => (
              <div key={field}>
                <label className="block text-xs text-gray-500 mb-1 capitalize">{field === "customer_nickname" ? "Nickname (shown to customers)" : field.replace(/_/g, " ")}</label>
                <input
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
                  value={(editForm[field] as string) ?? ""}
                  onChange={(e) => setEditForm((f) => ({ ...f, [field]: e.target.value }))}
                />
              </div>
            ))}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Delivery areas</label>
              <div className="flex flex-wrap gap-1">
                {AREAS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setEditForm((f) => {
                      const areas = (f.delivery_areas ?? []) as string[];
                      return { ...f, delivery_areas: areas.includes(a) ? areas.filter((x) => x !== a) : [...areas, a] };
                    })}
                    className={`px-2 py-0.5 rounded text-xs border ${((editForm.delivery_areas ?? []) as string[]).includes(a) ? "bg-blue-100 border-blue-300 text-blue-700" : "border-gray-200 text-gray-500"}`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => patchSub.mutate({ id: selected.id, name: editForm.name, customer_nickname: editForm.customer_nickname, admin_phone: editForm.admin_phone, admin_phone_2: editForm.admin_phone_2, delivery_areas: editForm.delivery_areas as string[], notes: editForm.notes })}
              className="w-full py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
            >
              Save changes
            </button>
          </div>

          {/* Active toggle */}
          <div className="border-t pt-3">
            {!confirmDeactivate ? (
              <button
                type="button"
                onClick={() => setConfirmDeactivate(true)}
                className={`text-sm ${selected.is_active ? "text-red-500 hover:text-red-700" : "text-green-600 hover:text-green-800"}`}
              >
                {selected.is_active ? "Deactivate" : "Reactivate"}
              </button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-gray-500">Menonaktifkan subcontractor ini tidak menghapus data historis.</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => patchSub.mutate({ id: selected.id, is_active: !selected.is_active })} className="px-3 py-1 bg-red-600 text-white text-xs rounded">Confirm</button>
                  <button type="button" onClick={() => setConfirmDeactivate(false)} className="px-3 py-1 border border-gray-200 text-xs rounded">Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* Performance */}
          <div className="border-t pt-3">
            <p className="text-xs font-medium text-gray-700 mb-2">Performance</p>
            <div className="grid grid-cols-2 gap-2 text-xs text-gray-500">
              <div>Total deliveries<br /><span className="text-gray-900 font-medium">{selected.total_delivery_count}</span></div>
              <div>Late deliveries<br /><span className="text-gray-900 font-medium">{selected.late_delivery_count}</span></div>
            </div>
          </div>

          {/* Off days */}
          <div className="border-t pt-3">
            <p className="text-xs font-medium text-gray-700 mb-2">Off days</p>
            <div className="space-y-1 mb-3">
              {(selected.subcontractor_off_days ?? [])
                .filter((d) => d.off_date >= today)
                .map((d) => (
                  <div key={d.id} className="flex items-center justify-between text-xs text-gray-600">
                    <span>{d.off_date}{d.reason ? ` — ${d.reason}` : ""}</span>
                    <button type="button" onClick={() => deleteOffDay.mutate(d.id)} className="text-red-400 hover:text-red-600 ml-2">Remove</button>
                  </div>
                ))}
            </div>
            <div className="flex gap-2">
              <input type="date" className="border border-gray-200 rounded px-2 py-1 text-xs" value={offDayForm.off_date} onChange={(e) => setOffDayForm((f) => ({ ...f, off_date: e.target.value }))} />
              <input placeholder="Reason" className="border border-gray-200 rounded px-2 py-1 text-xs flex-1" value={offDayForm.reason} onChange={(e) => setOffDayForm((f) => ({ ...f, reason: e.target.value }))} />
              <button type="button" onClick={() => addOffDay.mutate()} disabled={!offDayForm.off_date} className="px-2 py-1 bg-gray-800 text-white text-xs rounded disabled:opacity-40">Add</button>
            </div>
          </div>
        </div>
      )}

      {/* Add modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 space-y-3">
            <h2 className="font-semibold text-gray-900">Add Subcontractor</h2>
            {(["name", "customer_nickname", "admin_phone", "admin_phone_2", "notes"] as const).map((field) => (
              <div key={field}>
                <label className="block text-xs text-gray-500 mb-1 capitalize">{field === "customer_nickname" ? "Nickname (shown to customers)" : field.replace(/_/g, " ")}</label>
                <input className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm" value={addForm[field] ?? ""} onChange={(e) => setAddForm((f) => ({ ...f, [field]: e.target.value }))} />
              </div>
            ))}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Delivery areas</label>
              <div className="flex flex-wrap gap-1">
                {AREAS.map((a) => (
                  <button key={a} type="button"
                    onClick={() => setAddForm((f) => ({ ...f, delivery_areas: f.delivery_areas.includes(a) ? f.delivery_areas.filter((x) => x !== a) : [...f.delivery_areas, a] }))}
                    className={`px-2 py-0.5 rounded text-xs border ${addForm.delivery_areas.includes(a) ? "bg-blue-100 border-blue-300 text-blue-700" : "border-gray-200 text-gray-500"}`}
                  >{a}</button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => addSub.mutate()} disabled={!addForm.name} className="flex-1 py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-40">Add</button>
              <button type="button" onClick={() => setShowAdd(false)} className="flex-1 py-2 border border-gray-200 text-sm rounded-lg">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
